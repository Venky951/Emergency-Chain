const mongoose = require("mongoose");

/**
 * Enhanced User Schema with geospatial support
 * Tracks user location, role, and availability status
 * Compatible with both lat/lng and GeoJSON formats
 */
const userSchema = new mongoose.Schema(
  {
    // User info
    name: {
      type: String,
      required: true,
      trim: true,
    },

    phone: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    password: {
      type: String,
      required: true,
      select: false, // Don't return password by default
    },

    emergencyContact: {
      type: String,
      required: true,
      trim: true,
    },

    // User role
    role: {
      type: String,
      enum: ["citizen", "volunteer", "ambulance_driver", "hospital_staff"],
      default: "citizen",
      index: true,
    },

    // Location data stored in a single normalized shape
    location: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
      accuracy: { type: Number, default: null },
      updatedAt: { type: Date, default: Date.now },
    },

    geoLocation: {
      type: {
        type: String,
        enum: ["Point"],
      },
      coordinates: [Number],
    },

    // Timestamps
    lastSeen: {
      type: Date,
      default: Date.now,
    },

    lastLocationUpdate: {
      type: Date,
      default: null,
    },

    // Status
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    isAvailable: {
      type: Boolean,
      default: true,
    },

    // Permissions
    locationPermission: {
      type: Boolean,
      default: false,
    },

    notificationPermission: {
      type: Boolean,
      default: false,
    },

    termsAgreed: {
      type: Boolean,
      default: false,
    },

    // Offline sync tracking
    pendingSyncCount: {
      type: Number,
      default: 0,
    },

    // Metadata
    deviceId: String,
    userAgent: String,
  },
  {
    timestamps: true,
  },
);

// ✅ CRITICAL: Geospatial index for efficient location queries
userSchema.index({ geoLocation: "2dsphere" }, { sparse: true });
userSchema.index({ role: 1, isActive: 1 });
userSchema.index({ lastSeen: -1 });

/**
 * Find nearby users (helpers)
 * @param {Number} longitude
 * @param {Number} latitude
 * @param {Number} maxDistance in meters
 * @param {Array} excludeIds user IDs to exclude
 */
userSchema.statics.findNearby = function (
  longitude,
  latitude,
  maxDistance = 5000,
  excludeIds = [],
) {
  return this.find({
    _id: { $nin: excludeIds },
    "geoLocation.coordinates.0": { $ne: null },
    isActive: true,
    geoLocation: {
      $near: {
        $geometry: {
          type: "Point",
          coordinates: [longitude, latitude],
        },
        $maxDistance: maxDistance,
      },
    },
  })
    .select("name role phone location lastSeen isAvailable")
    .lean();
};

userSchema.statics.findNearbyResponders = function ({
  longitude,
  latitude,
  maxDistance,
  updatedAfter,
  excludeIds = [],
}) {
  return this.aggregate([
    {
      $geoNear: {
        near: {
          type: "Point",
          coordinates: [longitude, latitude],
        },
        key: "geoLocation",
        distanceField: "distanceMeters",
        maxDistance,
        spherical: true,
        query: {
          _id: { $nin: excludeIds },
          role: {
            $in: ["volunteer", "ambulance_driver", "hospital_staff"],
          },
          isActive: true,
          isAvailable: true,
          lastLocationUpdate: { $gte: updatedAfter },
          "geoLocation.coordinates.0": { $ne: null },
        },
      },
    },
    {
      $project: {
        _id: 1,
        name: 1,
        role: 1,
        isAvailable: 1,
        lastLocationUpdate: 1,
        distanceMeters: 1,
      },
    },
  ]);
};

/**
 * Update user location in the normalized structure
 */
userSchema.methods.updateLocation = function (
  latitude,
  longitude,
  accuracy = null,
) {
  this.location.latitude = latitude;
  this.location.longitude = longitude;
  this.location.accuracy = accuracy;
  this.location.updatedAt = new Date();

  this.geoLocation.coordinates = [longitude, latitude];
  this.lastLocationUpdate = new Date();
  this.lastSeen = new Date();
  return this.save();
};

module.exports = mongoose.model("User", userSchema);
