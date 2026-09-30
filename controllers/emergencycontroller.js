const EmergencyAlert = require("../models/emergencyAlert");
const Emergency = require("../models/emergency");
const User = require("../models/signup");
const { catchAsync, logError, logSOS, AppError } = require("../utils/logger");
const { isValidCoordinates } = require("../utils/location");

let ioInstance;

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

  try {
    const activeEmergency = await Emergency.findOne({
      citizen: citizenId,
      status: "TRIGGERED",
    });

    if (activeEmergency) {
      return res.status(409).json({
        error: "You already have an active emergency request.",
        status: activeEmergency.status,
      });
    }

    const emergency = await Emergency.create({
      citizen: citizenId,
      emergencyType,
      description: description || null,
      latitude,
      longitude,
      locationAccuracy: accuracy,
      status: "TRIGGERED",
    });

    return res.status(201).json({
      success: true,
      message: "Emergency request created",
      emergency: {
        id: emergency._id,
        status: emergency.status,
      },
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        error: "You already have an active emergency request.",
        status: "TRIGGERED",
      });
    }

    logError("Emergency creation failed", error, { citizenId });
    return res.status(500).json({
      error: "Unable to create the emergency request.",
    });
  }
});

/**
 * Initialize Socket.io for real-time updates
 */
exports.setIO = (io) => {
  ioInstance = io;

  // Handle socket connections
  io.on("connection", (socket) => {
    console.log(`[Socket] User connected: ${socket.id}`);

    // Listen for location updates
    socket.on("location-update", async (data) => {
      try {
        const userId = data.userId;
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

    // Handle disconnect
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
