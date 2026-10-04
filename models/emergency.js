const mongoose = require("mongoose");

const VALID_TRANSITIONS = Object.freeze({
  TRIGGERED: ["SEARCHING_FOR_HELP", "CANCELLED"],
  SEARCHING_FOR_HELP: ["RESPONDER_ASSIGNED", "CANCELLED"],
  RESPONDER_ASSIGNED: ["RESPONDER_ON_WAY", "CANCELLED"],
  RESPONDER_ON_WAY: ["HELP_REACHED", "CANCELLED"],
  HELP_REACHED: ["RESOLVED"],
  RESOLVED: [],
  CANCELLED: [],
});

const ACTIVE_STATUSES = [
  "TRIGGERED",
  "SEARCHING_FOR_HELP",
  "RESPONDER_ASSIGNED",
  "RESPONDER_ON_WAY",
  "HELP_REACHED",
];

const emergencySchema = new mongoose.Schema(
  {
    citizen: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    emergencyType: {
      type: String,
      required: true,
      trim: true,
      maxlength: 50,
    },

    description: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },

    latitude: {
      type: Number,
      required: true,
      min: -90,
      max: 90,
    },

    longitude: {
      type: Number,
      required: true,
      min: -180,
      max: 180,
    },

    locationAccuracy: {
      type: Number,
      min: 0,
      default: null,
    },

    assignedResponder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    assignedAt: {
      type: Date,
      default: null,
    },

    status: {
      type: String,
      enum: Object.keys(VALID_TRANSITIONS),
      default: "TRIGGERED",
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

emergencySchema.index(
  { citizen: 1 },
  {
    name: "citizen_active_emergency_unique",
    unique: true,
    partialFilterExpression: { status: { $in: ACTIVE_STATUSES } },
  },
);

emergencySchema.statics.canTransition = function (currentStatus, nextStatus) {
  return VALID_TRANSITIONS[currentStatus]?.includes(nextStatus) || false;
};

emergencySchema.statics.getValidTransitions = function (currentStatus) {
  return VALID_TRANSITIONS[currentStatus] || [];
};

emergencySchema.statics.getActiveStatuses = function () {
  return ACTIVE_STATUSES;
};

module.exports = mongoose.model("Emergency", emergencySchema);
