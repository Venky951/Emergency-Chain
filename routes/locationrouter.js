const express = require("express");
const router = express.Router();
const { body, validationResult } = require("express-validator");
const locationController = require("../controllers/locationcontroller");
const { requireAuth } = require("../middleware/auth");

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: errors.array()[0].msg,
    });
  }
  return next();
};

router.post(
  "/update-location",
  requireAuth,
  [
    body("latitude")
      .optional({ nullable: true })
      .isFloat({ min: -90, max: 90 })
      .withMessage("Latitude must be between -90 and 90."),
    body("longitude")
      .optional({ nullable: true })
      .isFloat({ min: -180, max: 180 })
      .withMessage("Longitude must be between -180 and 180."),
  ],
  handleValidationErrors,
  locationController.updateLocation,
);

router.get("/nearby-users", requireAuth, locationController.getNearbyUsers);

module.exports = router;
