const User = require("../models/signup");

// SAVE USER LOCATION
exports.updateLocation = async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).json({
        success: false,
      });
    }

    const { lat, lng } = req.body;

    await User.findByIdAndUpdate(
      req.session.userId,

      {
        location: {
          lat,
          lng,
        },
      },
    );

    res.json({
      success: true,
    });
  } catch (err) {
    console.log(err);

    res.status(500).json({
      success: false,
    });
  }
};

// GET NEARBY USERS
exports.getNearbyUsers = async (req, res) => {
  try {
    const { lat, lng } = req.query;

    const users = await User.find({
      "location.lat": { $ne: null },
      "location.lng": { $ne: null },

      _id: { $ne: req.session.userId },
    });

    // DISTANCE CALCULATION
    const nearbyUsers = users
      .map((user) => {
        const distance = calculateDistance(
          lat,
          lng,

          user.location.lat,
          user.location.lng,
        );

        return {
          name: user.name,
          role: user.role,
          distance: distance.toFixed(2),
        };
      })
      .filter((user) => user.distance <= 5)
      .sort((a, b) => a.distance - b.distance);

    res.json(nearbyUsers);
  } catch (err) {
    console.log(err);

    res.status(500).json([]);
  }
};

// DISTANCE FUNCTION
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;

  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}
