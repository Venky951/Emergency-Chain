const mongoose = require("mongoose");

const emergencySchema = new mongoose.Schema({
  victim: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },

  latitude: Number,
  longitude: Number,

  status: {
    type: String,
    default: "active",
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Emergency", emergencySchema);
