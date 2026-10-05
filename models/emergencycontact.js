const mongoose = require("mongoose");

const VERIFICATION_STATUSES = ["UNVERIFIED", "PENDING", "VERIFIED"];

const emergencyContactSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 100,
    },

    relationship: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 50,
    },

    phone: {
      type: String,
      required: true,
      trim: true,
      match: /^\+?[1-9]\d{6,14}$/,
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    verificationStatus: {
      type: String,
      enum: VERIFICATION_STATUSES,
      default: "UNVERIFIED",
    },
  },
  { timestamps: true },
);

emergencyContactSchema.index({ owner: 1, isActive: 1 });
emergencyContactSchema.index({ owner: 1, phone: 1 });

module.exports = mongoose.model("EmergencyContact", emergencyContactSchema);
