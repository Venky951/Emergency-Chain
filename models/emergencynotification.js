const mongoose = require("mongoose");

const NOTIFICATION_EVENTS = ["EMERGENCY_CREATED"];
const RECIPIENT_TYPES = ["EMERGENCY_CONTACT"];
const CHANNELS = ["SMS", "PHONE", "EMAIL", "PUSH", "IN_APP"];
const DELIVERY_STATUSES = ["PENDING", "UNAVAILABLE", "DELIVERED", "FAILED"];

const emergencyNotificationSchema = new mongoose.Schema(
  {
    emergency: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Emergency",
      required: true,
      index: true,
    },

    recipientType: {
      type: String,
      enum: RECIPIENT_TYPES,
      required: true,
    },

    recipientContact: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmergencyContact",
      required: true,
    },

    event: {
      type: String,
      enum: NOTIFICATION_EVENTS,
      required: true,
    },

    channel: {
      type: String,
      enum: CHANNELS,
      required: true,
    },

    deliveryStatus: {
      type: String,
      enum: DELIVERY_STATUSES,
      default: "PENDING",
    },

    retryCount: {
      type: Number,
      min: 0,
      default: 0,
    },

    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
    },
  },
  { timestamps: true },
);

emergencyNotificationSchema.index({ emergency: 1, createdAt: 1 });
emergencyNotificationSchema.index(
  { emergency: 1, recipientContact: 1, event: 1, channel: 1 },
  { unique: true },
);

module.exports = mongoose.model(
  "EmergencyNotification",
  emergencyNotificationSchema,
);
