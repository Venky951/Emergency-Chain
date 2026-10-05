const mongoose = require("mongoose");

const HISTORY_EVENTS = [
  "CREATED",
  "SEARCHING_FOR_HELP",
  "RESPONDER_ASSIGNED",
  "RESPONDER_ON_WAY",
  "HELP_REACHED",
  "CANCELLED",
  "RESOLVED",
];

const STATUS_VALUES = [
  "TRIGGERED",
  "SEARCHING_FOR_HELP",
  "RESPONDER_ASSIGNED",
  "RESPONDER_ON_WAY",
  "HELP_REACHED",
  "RESOLVED",
  "CANCELLED",
];

const emergencyHistorySchema = new mongoose.Schema(
  {
    emergency: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Emergency",
      required: true,
      index: true,
    },

    event: {
      type: String,
      enum: HISTORY_EVENTS,
      required: true,
    },

    fromStatus: {
      type: String,
      enum: STATUS_VALUES,
      default: null,
    },

    toStatus: {
      type: String,
      enum: STATUS_VALUES,
      required: true,
    },

    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    actorRole: {
      type: String,
      required: true,
      trim: true,
    },

    assignedResponder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    versionKey: false,
    _id: true,
  },
);

emergencyHistorySchema.index({ emergency: 1, createdAt: 1, _id: 1 });

module.exports = mongoose.model("EmergencyHistory", emergencyHistorySchema);
