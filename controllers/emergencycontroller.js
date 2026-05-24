const User = require("../models/signup");
const Emergency = require("../models/emergency");

exports.triggerSOS = async (req, res) => {
  try {
    const { lat, lng } = req.body;

    // CREATE EMERGENCY
    const emergency = await Emergency.create({
      victim: req.session.userId,

      latitude: lat,
      longitude: lng,
    });

    // FIND NEARBY USERS
    const users = await User.find({
      _id: { $ne: req.session.userId },

      "location.latitude": {
        $exists: true,
      },
    });

    // SIMPLE DISTANCE FILTER
    const nearbyUsers = users.filter((user) => {
      const distanceLat = Math.abs(user.location.latitude - lat);

      const distanceLng = Math.abs(user.location.longitude - lng);

      return distanceLat < 0.005 && distanceLng < 0.005;
    });

    res.json({
      success: true,
      nearbyUsers,
      emergency,
    });
  } catch (err) {
    console.log(err);

    res.status(500).json({
      success: false,
    });
  }
};
