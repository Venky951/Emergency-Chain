const mongoose = require("mongoose");

const emergencySchema = new mongoose.Schema(
  {
    citizen: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
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

    status: {
      type: String,
      enum: ["TRIGGERED", "ASSIGNED", "RESOLVED", "CANCELLED"],
      default: "TRIGGERED",
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

emergencySchema.index(
  { citizen: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "TRIGGERED" },
  },
);

module.exports = mongoose.model("Emergency", emergencySchema);
