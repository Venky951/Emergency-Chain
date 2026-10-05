const User = require("../models/signup");
const { catchAsync, logLocation, AppError } = require("../utils/logger");
const { isValidCoordinates, calculateDistance } = require("../utils/location");
const MAX_NEARBY_RADIUS_METERS = Math.max(
  100,
  Number(process.env.MAX_NEARBY_RADIUS_METERS || 5000),
);

const normalizeLocation = (payload = {}) => {
  const latitude = Number(payload.latitude ?? payload.lat ?? NaN);
  const longitude = Number(payload.longitude ?? payload.lng ?? NaN);
  const accuracyValue = payload.accuracy ?? payload.accuracy ?? null;
  const accuracy = Number.isFinite(Number(accuracyValue))
    ? Number(accuracyValue)
    : null;

  return { latitude, longitude, accuracy };
};

exports.updateLocation = catchAsync(async (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    throw new AppError("Authentication required.", 401);
  }

  const { latitude, longitude, accuracy } = normalizeLocation(req.body);
  if (!isValidCoordinates(latitude, longitude)) {
    throw new AppError("Invalid latitude or longitude.", 400);
  }

  const validAccuracy = accuracy !== null && accuracy >= 0 ? accuracy : null;

  const user = await User.findByIdAndUpdate(
    userId,
    {
      location: {
        latitude,
        longitude,
        accuracy: validAccuracy,
        updatedAt: new Date(),
      },
      geoLocation: {
        type: "Point",
        coordinates: [longitude, latitude],
      },
      lastLocationUpdate: new Date(),
      lastSeen: new Date(),
    },
    { new: true },
  );

  if (!user) {
    throw new AppError("User not found.", 404);
  }

  logLocation(userId, latitude, longitude);

  res.json({
    success: true,
    message: "Location updated.",
    location: {
      latitude,
      longitude,
      accuracy: validAccuracy,
      updatedAt: new Date().toISOString(),
    },
  });
});

exports.getNearbyUsers = catchAsync(async (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    throw new AppError("Authentication required.", 401);
  }

  const latitude = Number(req.query.latitude ?? req.query.lat ?? NaN);
  const longitude = Number(req.query.longitude ?? req.query.lng ?? NaN);
  const radius = Number(req.query.radius ?? 5000);

  if (!isValidCoordinates(latitude, longitude)) {
    throw new AppError("Invalid latitude or longitude.", 400);
  }

  if (!Number.isFinite(radius) || radius <= 0) {
    throw new AppError("Invalid radius.", 400);
  }
  if (radius > MAX_NEARBY_RADIUS_METERS) {
    throw new AppError("Requested radius is too large.", 400);
  }

  const nearbyUsers = await User.findNearby(longitude, latitude, radius, [
    userId,
  ]);
  const response = nearbyUsers
    .map((user) => {
      const userLatitude =
        user.location?.latitude ?? user.location?.lat ?? null;
      const userLongitude =
        user.location?.longitude ?? user.location?.lng ?? null;

      if (userLatitude === null || userLongitude === null) {
        return null;
      }

      const distance = calculateDistance(
        latitude,
        longitude,
        userLatitude,
        userLongitude,
      );

      return {
        id: user._id,
        name: user.name,
        role: user.role,
        distance: Number(distance.toFixed(2)),
        lastSeen: user.lastSeen,
        isAvailable: user.isAvailable,
        location: {
          latitude: userLatitude,
          longitude: userLongitude,
        },
      };
    })
    .filter(Boolean);

  res.json({
    success: true,
    count: response.length,
    users: response,
  });
});

exports.getLocation = catchAsync(async (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    throw new AppError("Authentication required.", 401);
  }

  const user = await User.findById(userId).select(
    "location geoLocation lastLocationUpdate",
  );
  if (!user || !user.location || user.location.latitude === null) {
    throw new AppError("Location not available.", 404);
  }

  res.json({
    success: true,
    location: {
      latitude: user.location.latitude,
      longitude: user.location.longitude,
      accuracy: user.location.accuracy,
      lastUpdate: user.lastLocationUpdate,
    },
  });
});

exports.setLocationPermission = catchAsync(async (req, res) => {
  const userId = req.session.userId;
  const { granted } = req.body;

  if (!userId) {
    throw new AppError("Authentication required.", 401);
  }

  await User.findByIdAndUpdate(userId, {
    locationPermission: granted === true,
  });

  res.json({
    success: true,
    message: `Location permission ${granted ? "granted" : "denied"}.`,
  });
});

exports.calculateDistance = (lat1, lng1, lat2, lng2) => {
  return calculateDistance(lat1, lng1, lat2, lng2);
};
