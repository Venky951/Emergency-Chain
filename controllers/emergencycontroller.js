const EmergencyAlert = require("../models/emergencyAlert");
const Emergency = require("../models/emergency");
const EmergencyHistory = require("../models/emergencyhistory");
const User = require("../models/signup");
const mongoose = require("mongoose");
const { catchAsync, logError, logSOS, AppError } = require("../utils/logger");
const { isValidCoordinates } = require("../utils/location");
const {
  createEmergencyContactNotifications,
} = require("../services/emergencyNotificationService");

let ioInstance;
const RESPONDER_SEARCH_RADIUS_KM = Number.isFinite(
  Number(process.env.RESPONDER_SEARCH_RADIUS_KM),
)
  ? Math.max(0.1, Number(process.env.RESPONDER_SEARCH_RADIUS_KM))
  : 5;
const LOCATION_FRESHNESS_MINUTES = Number.isFinite(
  Number(process.env.LOCATION_FRESHNESS_MINUTES),
)
  ? Math.max(1, Number(process.env.LOCATION_FRESHNESS_MINUTES))
  : 10;
const RESPONDER_ROLES = ["volunteer", "ambulance_driver", "hospital_staff"];
const EMERGENCY_UPDATED_EVENT = "emergency:updated";

const getUserRoom = (userId) => `user:${String(userId)}`;

const getEmergencyUpdatePayload = (emergency) => ({
  emergencyId: String(emergency._id),
  status: emergency.status,
  assignedResponder: emergency.assignedResponder
    ? String(emergency.assignedResponder)
    : null,
  assignedAt: emergency.assignedAt
    ? new Date(emergency.assignedAt).toISOString()
    : null,
  updatedAt: emergency.updatedAt
    ? new Date(emergency.updatedAt).toISOString()
    : null,
});

const emitEmergencyUpdated = (emergency) => {
  if (!ioInstance || !emergency) return;

  const recipients = new Set([getUserRoom(emergency.citizen)]);
  if (emergency.assignedResponder) {
    recipients.add(getUserRoom(emergency.assignedResponder));
  }

  const payload = getEmergencyUpdatePayload(emergency);
  for (const room of recipients) {
    ioInstance.to(room).emit(EMERGENCY_UPDATED_EVENT, payload);
  }
};

const releaseAssignedResponder = async (emergencyId, responderId) => {
  if (!responderId) return;

  const activeAssignment = await Emergency.exists({
    _id: { $ne: emergencyId },
    assignedResponder: responderId,
    status: { $in: Emergency.getActiveStatuses() },
  });

  if (activeAssignment) return;

  await User.updateOne(
    { _id: responderId, isAvailable: false },
    { $set: { isAvailable: true } },
  );
};

const getActorRole = async (req, session) => {
  if (req.user?.role) return req.user.role;
  if (req.session?.userRole) return req.session.userRole;

  const actor = await User.findById(req.session.userId)
    .select("role")
    .session(session)
    .lean();
  return actor?.role;
};

const createHistoryEntry = async ({
  session,
  emergency,
  event,
  fromStatus,
  toStatus,
  actor,
  actorRole,
  assignedResponder = null,
}) => {
  await EmergencyHistory.create(
    [
      {
        emergency: emergency._id,
        event,
        fromStatus,
        toStatus,
        actor,
        actorRole,
        assignedResponder,
      },
    ],
    { session },
  );
};

exports.createEmergency = catchAsync(async (req, res) => {
  const citizenId = req.session.userId;
  const latitude = Number(req.body.latitude);
  const longitude = Number(req.body.longitude);
  const accuracy =
    req.body.accuracy === undefined ||
    req.body.accuracy === null ||
    req.body.accuracy === ""
      ? null
      : Number(req.body.accuracy);
  const emergencyType = String(req.body.emergencyType ?? req.body.type ?? "")
    .trim()
    .toUpperCase();
  const description = String(req.body.description ?? "").trim();

  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    return res
      .status(400)
      .json({ error: "Valid latitude and longitude are required." });
  }

  if (!emergencyType || emergencyType.length > 50) {
    return res
      .status(400)
      .json({ error: "A valid emergency type is required." });
  }

  if (description.length > 1000) {
    return res
      .status(400)
      .json({ error: "Description must be 1000 characters or less." });
  }

  if (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0)) {
    return res
      .status(400)
      .json({ error: "Location accuracy must be a valid positive number." });
  }

  const session = await mongoose.startSession();
  let emergency;

  try {
    await session.withTransaction(async () => {
      const activeEmergency = await Emergency.findOne({
        citizen: citizenId,
        status: { $in: Emergency.getActiveStatuses() },
      })
        .session(session)
        .lean();

      if (activeEmergency) {
        throw new AppError(
          "You already have an active emergency request.",
          409,
        );
      }

      const actorRole = await getActorRole(req, session);
      if (!actorRole) {
        throw new AppError("Authenticated user was not found.", 401);
      }

      [emergency] = await Emergency.create(
        [
          {
            citizen: citizenId,
            emergencyType,
            description: description || null,
            latitude,
            longitude,
            locationAccuracy: accuracy,
            status: "TRIGGERED",
          },
        ],
        { session },
      );

      await createHistoryEntry({
        session,
        emergency,
        event: "CREATED",
        fromStatus: null,
        toStatus: "TRIGGERED",
        actor: citizenId,
        actorRole,
      });

      await createEmergencyContactNotifications({
        session,
        emergency,
        ownerId: citizenId,
      });
    });

    emitEmergencyUpdated(emergency);

    return res.status(201).json({
      success: true,
      message: "Emergency request created",
      emergency: {
        id: emergency._id,
        status: emergency.status,
      },
    });
  } catch (error) {
    if (error.statusCode === 409 || error.code === 11000) {
      return res.status(409).json({
        error: "You already have an active emergency request.",
        status: "TRIGGERED",
      });
    }

    if (error.statusCode === 401) {
      return res.status(401).json({ error: error.message });
    }

    logError("Emergency creation failed", error, { citizenId });
    return res.status(500).json({
      error: "Unable to create the emergency request.",
    });
  } finally {
    await session.endSession();
  }
});

exports.updateEmergencyStatus = catchAsync(async (req, res) => {
  const requestedStatus = String(req.body.status || "")
    .trim()
    .toUpperCase();
  const allowedStatuses = Emergency.schema.path("status").enumValues;

  if (!requestedStatus || !allowedStatuses.includes(requestedStatus)) {
    return res
      .status(400)
      .json({ error: "A valid emergency status is required." });
  }

  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: "Emergency not found." });
  }

  let emergency;
  try {
    emergency = await Emergency.findById(req.params.id);
  } catch (error) {
    logError("Emergency lookup failed", error, {
      emergencyId: req.params.id,
      citizenId: req.session.userId,
    });
    return res.status(500).json({ error: "Unable to update the emergency." });
  }

  if (!emergency) {
    return res.status(404).json({ error: "Emergency not found." });
  }

  const requesterId = String(req.session.userId);
  const isCitizen = String(emergency.citizen) === requesterId;
  const isAssignedResponder =
    emergency.assignedResponder &&
    String(emergency.assignedResponder) === requesterId;

  if (!isCitizen && !isAssignedResponder) {
    return res.status(403).json({ error: "You cannot update this emergency." });
  }

  if (!Emergency.canTransition(emergency.status, requestedStatus)) {
    return res.status(409).json({
      error: `Cannot change emergency status from ${emergency.status} to ${requestedStatus}.`,
      status: emergency.status,
    });
  }

  const citizenCanUpdate = ["SEARCHING_FOR_HELP", "CANCELLED"].includes(
    requestedStatus,
  );
  const responderCanUpdate = ["RESPONDER_ON_WAY", "HELP_REACHED"].includes(
    requestedStatus,
  );
  const citizenCanResolve = requestedStatus === "RESOLVED";

  if (
    !(
      (isCitizen && (citizenCanUpdate || citizenCanResolve)) ||
      (isAssignedResponder && responderCanUpdate)
    )
  ) {
    return res.status(403).json({
      error: "You cannot set this emergency status.",
      status: emergency.status,
    });
  }

  const expectedStatus = emergency.status;
  const updatedAt = new Date();
  let updatedEmergency;
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      const actorRole = await getActorRole(req, session);
      if (!actorRole) {
        throw new AppError("Authenticated user was not found.", 401);
      }

      updatedEmergency = await Emergency.findOneAndUpdate(
        { _id: emergency._id, status: expectedStatus },
        { $set: { status: requestedStatus, updatedAt } },
        { new: true, runValidators: true, session },
      );

      if (!updatedEmergency) {
        throw new AppError(
          `Cannot change emergency status from ${expectedStatus} to ${requestedStatus}.`,
          409,
        );
      }

      await createHistoryEntry({
        session,
        emergency: updatedEmergency,
        event: requestedStatus,
        fromStatus: expectedStatus,
        toStatus: requestedStatus,
        actor: req.session.userId,
        actorRole,
        assignedResponder: updatedEmergency.assignedResponder,
      });
    });
  } catch (error) {
    await session.endSession();

    if (error.statusCode === 409) {
      return res.status(409).json({
        error: error.message,
        status: expectedStatus,
      });
    }

    if (error.statusCode === 401) {
      return res.status(401).json({ error: error.message });
    }

    logError("Emergency status update failed", error, {
      emergencyId: emergency._id,
      citizenId: req.session.userId,
      requestedStatus,
    });
    return res.status(500).json({ error: "Unable to update the emergency." });
  }

  await session.endSession();

  if (["CANCELLED", "RESOLVED"].includes(requestedStatus)) {
    try {
      await releaseAssignedResponder(
        updatedEmergency._id,
        updatedEmergency.assignedResponder,
      );
    } catch (error) {
      logError("Responder availability cleanup failed", error, {
        emergencyId: updatedEmergency._id,
        responderId: updatedEmergency.assignedResponder,
        status: requestedStatus,
      });
    }
  }

  emitEmergencyUpdated(updatedEmergency);

  return res.status(200).json({
    success: true,
    message:
      requestedStatus === "CANCELLED"
        ? "Emergency cancelled"
        : "Emergency status updated",
    emergency: updatedEmergency,
  });
});

exports.getNearbyResponders = catchAsync(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: "Emergency not found." });
  }

  const emergency = await Emergency.findById(req.params.id).select(
    "citizen latitude longitude status",
  );

  if (!emergency) {
    return res.status(404).json({ error: "Emergency not found." });
  }

  if (String(emergency.citizen) !== String(req.session.userId)) {
    return res.status(403).json({ error: "You cannot access this emergency." });
  }

  if (!Emergency.getActiveStatuses().includes(emergency.status)) {
    return res.status(409).json({
      error: "Nearby responders are unavailable for this emergency status.",
      status: emergency.status,
    });
  }

  const latitude = Number(emergency.latitude);
  const longitude = Number(emergency.longitude);
  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    return res.status(400).json({ error: "Emergency location is invalid." });
  }

  try {
    const updatedAfter = new Date(
      Date.now() - LOCATION_FRESHNESS_MINUTES * 60 * 1000,
    );
    const responders = await User.findNearbyResponders({
      longitude,
      latitude,
      maxDistance: RESPONDER_SEARCH_RADIUS_KM * 1000,
      updatedAfter,
      excludeIds: [emergency.citizen],
    });

    return res.status(200).json({
      success: true,
      radiusKm: RESPONDER_SEARCH_RADIUS_KM,
      freshnessMinutes: LOCATION_FRESHNESS_MINUTES,
      responders: responders.map((responder) => ({
        id: responder._id,
        role: responder.role,
        displayName: responder.name,
        distanceKm: Number((responder.distanceMeters / 1000).toFixed(2)),
        isAvailable: responder.isAvailable,
        locationUpdatedAt: responder.lastLocationUpdate,
      })),
    });
  } catch (error) {
    logError("Nearby responder lookup failed", error, {
      emergencyId: emergency._id,
      citizenId: req.session.userId,
    });
    return res.status(500).json({
      error: "Unable to find nearby responders.",
    });
  }
});

exports.getSearchingEmergencies = catchAsync(async (req, res) => {
  const emergencies = await Emergency.find({
    status: "SEARCHING_FOR_HELP",
    assignedResponder: null,
  })
    .sort({ createdAt: 1 })
    .limit(20)
    .select("_id emergencyType description status createdAt")
    .lean();

  return res.status(200).json({
    success: true,
    emergencies,
  });
});

exports.getEmergencyHistory = catchAsync(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: "Emergency not found." });
  }

  const emergency = await Emergency.findById(req.params.id).select(
    "citizen assignedResponder",
  );
  if (!emergency) {
    return res.status(404).json({ error: "Emergency not found." });
  }

  const requesterId = String(req.session.userId);
  const isCitizen = String(emergency.citizen) === requesterId;
  const isAssignedResponder =
    emergency.assignedResponder &&
    String(emergency.assignedResponder) === requesterId;

  if (!isCitizen && !isAssignedResponder) {
    return res.status(403).json({
      error: "You cannot access this emergency history.",
    });
  }

  const history = await EmergencyHistory.find({ emergency: emergency._id })
    .sort({ createdAt: 1, _id: 1 })
    .select(
      "emergency event fromStatus toStatus actor actorRole assignedResponder createdAt",
    )
    .lean();

  return res.status(200).json({
    success: true,
    history,
  });
});

exports.acceptEmergency = catchAsync(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: "Emergency not found." });
  }

  const emergency = await Emergency.findById(req.params.id).select(
    "status assignedResponder",
  );
  if (!emergency) {
    return res.status(404).json({ error: "Emergency not found." });
  }

  if (
    emergency.status !== "SEARCHING_FOR_HELP" ||
    emergency.assignedResponder
  ) {
    return res.status(409).json({
      error: "Emergency is no longer available for acceptance.",
      status: emergency.status,
    });
  }

  const responderId = req.session.userId;
  const session = await mongoose.startSession();
  let assignedEmergency;

  try {
    await session.withTransaction(async () => {
      const responder = await User.findOneAndUpdate(
        {
          _id: responderId,
          role: { $in: RESPONDER_ROLES },
          isActive: true,
          isAvailable: true,
        },
        { $set: { isAvailable: false } },
        { new: true, session },
      )
        .select("_id role name")
        .lean();

      if (!responder) {
        throw new AppError(
          "Responder is unavailable for a new assignment.",
          409,
        );
      }

      const assignedAt = new Date();
      assignedEmergency = await Emergency.findOneAndUpdate(
        {
          _id: req.params.id,
          status: "SEARCHING_FOR_HELP",
          assignedResponder: null,
        },
        {
          $set: {
            assignedResponder: responder._id,
            assignedAt,
            status: "RESPONDER_ASSIGNED",
            updatedAt: assignedAt,
          },
        },
        { new: true, runValidators: true, session },
      );

      if (!assignedEmergency) {
        throw new AppError(
          "Emergency is no longer available for acceptance.",
          409,
        );
      }

      await createHistoryEntry({
        session,
        emergency: assignedEmergency,
        event: "RESPONDER_ASSIGNED",
        fromStatus: "SEARCHING_FOR_HELP",
        toStatus: "RESPONDER_ASSIGNED",
        actor: responder._id,
        actorRole: responder.role,
        assignedResponder: responder._id,
      });
    });

    emitEmergencyUpdated(assignedEmergency);

    return res.status(200).json({
      success: true,
      message: "Emergency assigned to responder.",
      emergency: assignedEmergency,
    });
  } catch (error) {
    await session.endSession();

    if (error.statusCode === 409) {
      return res.status(409).json({ error: error.message });
    }

    logError("Emergency acceptance failed", error, {
      emergencyId: req.params.id,
      responderId,
    });
    return res.status(500).json({
      error: "Unable to accept the emergency.",
    });
  } finally {
    if (session.hasEnded === false) await session.endSession();
  }
});

/**
 * Initialize Socket.io for real-time updates
 */
exports.setIO = (io) => {
  ioInstance = io;
  if (!io) return;

  io.use((socket, next) => {
    const session = socket.request.session;
    if (!session?.isLoggedIn || !session.userId) {
      return next(new Error("Authentication required."));
    }

    socket.data.userId = String(session.userId);
    return next();
  });

  io.on("connection", (socket) => {
    console.log(`[Socket] User connected: ${socket.id}`);
    socket.join(getUserRoom(socket.data.userId));

    socket.on("location-update", async (data) => {
      try {
        const userId = socket.data.userId;
        const latitude = Number(data.latitude ?? data.lat ?? NaN);
        const longitude = Number(data.longitude ?? data.lng ?? NaN);
        if (!userId || !isValidCoordinates(latitude, longitude)) return;

        await User.findByIdAndUpdate(userId, {
          location: {
            latitude,
            longitude,
            accuracy: data.accuracy != null ? Number(data.accuracy) : null,
            updatedAt: new Date(),
          },
          geoLocation: { coordinates: [longitude, latitude] },
          lastLocationUpdate: new Date(),
          lastSeen: new Date(),
        });

        io.emit("user-location", {
          userId,
          latitude,
          longitude,
          timestamp: new Date(),
        });
      } catch (err) {
        console.error("[Socket] Location update error:", err);
      }
    });

    socket.on("disconnect", () => {
      console.log(`[Socket] User disconnected: ${socket.id}`);
    });
  });
};

/**
 * Level 1 SOS - Emergency Contacts Only (5 second hold)
 * Status: active for 10 minutes
 */
exports.triggerLevel1 = catchAsync(async (req, res) => {
  const userId = req.session.userId;
  const latitude = Number(req.body.latitude ?? req.body.lat ?? NaN);
  const longitude = Number(req.body.longitude ?? req.body.lng ?? NaN);
  const reason = String(req.body.reason || "Emergency").trim();

  if (!userId || !isValidCoordinates(latitude, longitude)) {
    throw new AppError("Invalid location or user.", 400);
  }

  if (!reason || reason.length < 3) {
    throw new AppError("Reason is required.", 400);
  }

  const alert = new EmergencyAlert({
    userId,
    level: 1,
    location: {
      type: "Point",
      coordinates: [longitude, latitude],
    },
    reason,
    status: "active",
    broadcastRadius: 0,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  await alert.save();

  logSOS(userId, 1, latitude, longitude, { reason });

  if (ioInstance) {
    ioInstance.emit("sos-level-1", {
      alertId: alert._id,
      userId,
      latitude,
      longitude,
      reason,
      timestamp: new Date(),
    });
  }

  res.json({
    success: true,
    message: "Level 1 alert sent to emergency contacts.",
    alertId: alert._id,
  });
});

/**
 * Level 2 SOS - Nearby Helpers (500m radius, slide to confirm)
 * Status: active for 20 minutes
 */
exports.triggerLevel2 = catchAsync(async (req, res) => {
  const userId = req.session.userId;
  const latitude = Number(req.body.latitude ?? req.body.lat ?? NaN);
  const longitude = Number(req.body.longitude ?? req.body.lng ?? NaN);
  const reason = String(req.body.reason || "Emergency").trim();
  const message = String(req.body.message || "").trim();

  if (!userId || !isValidCoordinates(latitude, longitude)) {
    throw new AppError("Invalid location or user.", 400);
  }

  if (!reason || reason.length < 3) {
    throw new AppError("Reason is required.", 400);
  }

  const alert = new EmergencyAlert({
    userId,
    level: 2,
    location: {
      type: "Point",
      coordinates: [longitude, latitude],
    },
    reason,
    message,
    status: "active",
    broadcastRadius: 500,
    expiresAt: new Date(Date.now() + 20 * 60 * 1000),
  });

  await alert.save();

  const nearbyUsers = await User.findNearby(longitude, latitude, 500, [userId]);

  logSOS(userId, 2, latitude, longitude, {
    reason,
    nearbyCount: nearbyUsers.length,
  });

  if (ioInstance) {
    ioInstance.emit("sos-level-2", {
      alertId: alert._id,
      userId,
      latitude,
      longitude,
      reason,
      message,
      nearbyCount: nearbyUsers.length,
      timestamp: new Date(),
    });
  }

  res.json({
    success: true,
    message: `Level 2 alert sent to ${nearbyUsers.length} nearby helpers.`,
    alertId: alert._id,
    nearbyCount: nearbyUsers.length,
  });
});

/**
 * Level 3 SOS - All Nearby Helpers (no distance limit, instant)
 * Status: active for 30 minutes, shows blinking marker
 */
exports.triggerLevel3 = catchAsync(async (req, res) => {
  const userId = req.session.userId;
  const latitude = Number(req.body.latitude ?? req.body.lat ?? NaN);
  const longitude = Number(req.body.longitude ?? req.body.lng ?? NaN);
  const reason = String(req.body.reason || "Emergency").trim();
  const message = String(req.body.message || "").trim();

  if (!userId || !isValidCoordinates(latitude, longitude)) {
    throw new AppError("Invalid location or user.", 400);
  }

  if (!reason || reason.length < 3) {
    throw new AppError("Reason is required.", 400);
  }

  const user = await User.findById(userId);
  if (!user) {
    throw new AppError("User not found.", 404);
  }

  const alert = new EmergencyAlert({
    userId,
    level: 3,
    location: {
      type: "Point",
      coordinates: [longitude, latitude],
    },
    reason,
    message,
    status: "active",
    broadcastRadius: 999999,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });

  await alert.save();

  logSOS(userId, 3, latitude, longitude, { reason, userName: user.name });

  if (ioInstance) {
    ioInstance.emit("sos-level-3", {
      alertId: alert._id,
      userId,
      userName: user.name,
      userPhone: user.phone,
      latitude,
      longitude,
      reason,
      message,
      timestamp: new Date(),
      blinking: true,
    });
  }

  res.json({
    success: true,
    message: "Level 3 critical alert sent to nearby responders.",
    alertId: alert._id,
  });
});

/**
 * Get active nearby alerts
 * Only for authenticated users
 */
exports.getNearbyAlerts = catchAsync(async (req, res) => {
  const { lat, lng } = req.query;
  const userId = req.session.userId;

  const latitude = Number(req.query.latitude ?? req.query.lat ?? NaN);
  const longitude = Number(req.query.longitude ?? req.query.lng ?? NaN);

  if (!userId || !isValidCoordinates(latitude, longitude)) {
    throw new AppError("Invalid location.", 400);
  }

  const alerts = await EmergencyAlert.findNearby(longitude, latitude, 5000);

  res.json({
    success: true,
    alerts,
    count: alerts.length,
  });
});

/**
 * Accept SOS help
 */
exports.acceptAlert = catchAsync(async (req, res) => {
  const { alertId } = req.body;
  const userId = req.session.userId;

  const alert = await EmergencyAlert.findByIdAndUpdate(
    alertId,
    {
      $addToSet: { acceptedBy: userId },
    },
    { new: true },
  );

  if (!alert) {
    throw new AppError("Alert not found", 404);
  }

  // Notify via socket
  if (ioInstance) {
    ioInstance.emit("alert-accepted", {
      alertId,
      acceptedBy: userId,
      totalAccepted: alert.acceptedBy.length,
    });
  }

  res.json({
    success: true,
    message: "Help accepted",
    totalAccepted: alert.acceptedBy.length,
  });
});

/**
 * Cancel SOS alert
 */
exports.cancelAlert = catchAsync(async (req, res) => {
  const { alertId } = req.body;
  const userId = req.session.userId;

  const alert = await EmergencyAlert.findOne({
    _id: alertId,
    userId: userId,
  });

  if (!alert) {
    throw new AppError("Alert not found or not yours", 404);
  }

  alert.status = "cancelled";
  await alert.save();

  logSOS(userId, 0, null, null, { action: "cancelled", alertId });

  if (ioInstance) {
    ioInstance.emit("alert-cancelled", { alertId });
  }

  res.json({ success: true, message: "Alert cancelled" });
});
