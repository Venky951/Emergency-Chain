const mongoose = require("mongoose");

/**
 * Emergency Alert Schema
 * Tracks all emergency SOS alerts with levels and status
 *
 * Level 1: Emergency contact notification (5s hold)
 * Level 2: Nearby helpers broadcast (slide confirm, 500m radius)
 * Level 3: All nearby helpers alert (instant, all distance)
 */
const emergencyAlertSchema = new mongoose.Schema(
  {
    // User who triggered the alert
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Alert level (1, 2, or 3)
    level: {
      type: Number,
      enum: [1, 2, 3],
      required: true,
    },

    // Location of emergency
    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        required: true,
      },
    },

    // Additional info
    reason: {
      type: String,
      default: null,
    },

    message: {
      type: String,
      default: null,
    },

    // Status tracking
    status: {
      type: String,
      enum: ["active", "accepted", "completed", "expired", "cancelled"],
      default: "active",
      index: true,
    },

    // Helpers who accepted
    acceptedBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    // Expiry (default 30 minutes)
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 30 * 60 * 1000),
      index: true,
    },

    // Broadcast radius in meters (default 500m for level 2)
    broadcastRadius: {
      type: Number,
      default: 500,
    },

    // Server sync tracking
    syncStatus: {
      type: String,
      enum: ["pending", "synced", "failed"],
      default: "pending",
    },

    // Offline creation
    createdOffline: {
      type: Boolean,
      default: false,
    },

    // Timestamps
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

// ✅ CRITICAL: Geospatial index for efficient nearby queries
emergencyAlertSchema.index({ location: "2dsphere" });
emergencyAlertSchema.index({ status: 1, expiresAt: 1 });
emergencyAlertSchema.index({ createdAt: -1 });

/**
 * Find active alerts near a location
 * @param {Number} longitude
 * @param {Number} latitude
 * @param {Number} maxDistance in meters
 */
emergencyAlertSchema.statics.findNearby = function (
  longitude,
  latitude,
  maxDistance = 1000,
) {
  return this.find({
    location: {
      $near: {
        $geometry: {
          type: "Point",
          coordinates: [longitude, latitude],
        },
        $maxDistance: maxDistance,
      },
    },
    status: "active",
    expiresAt: { $gt: new Date() },
  }).populate("userId", "name role phone");
};

/**
 * Expire old alerts (cleanup job)
 */
emergencyAlertSchema.statics.expireOldAlerts = function () {
  return this.updateMany(
    {
      status: "active",
      expiresAt: { $lt: new Date() },
    },
    {
      $set: { status: "expired" },
    },
  );
};

module.exports = mongoose.model("EmergencyAlert", emergencyAlertSchema);
