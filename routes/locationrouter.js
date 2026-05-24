const express = require("express");

const router = express.Router();

const locationController = require("../controllers/locationcontroller");

router.post("/update-location", locationController.updateLocation);

router.get("/nearby-users", locationController.getNearbyUsers);

module.exports = router;
