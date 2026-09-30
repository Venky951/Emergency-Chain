const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const { body, validationResult } = require("express-validator");
const emergencyController = require("../controllers/emergencycontroller");
const { requireAuth, requireRole } = require("../middleware/auth");

const sosLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many SOS requests. Please wait before sending another one.",
  },
});

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: errors.array()[0].msg,
    });
  }
  return next();
};

const sosValidation = [
  body("latitude")
    .optional({ nullable: true })
    .isFloat({ min: -90, max: 90 })
    .withMessage("Latitude must be between -90 and 90."),
  body("longitude")
    .optional({ nullable: true })
    .isFloat({ min: -180, max: 180 })
    .withMessage("Longitude must be between -180 and 180."),
  body("reason")
    .optional()
    .trim()
    .isLength({ min: 3, max: 200 })
    .withMessage("Reason must be between 3 and 200 characters."),
  body("message")
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage("Message must be 500 characters or less."),
];

router.post(
  "/api/emergency/level1",
  requireAuth,
  requireRole("citizen"),
  sosLimiter,
  sosValidation,
  handleValidationErrors,
  emergencyController.triggerLevel1,
);
router.post(
  "/api/emergency/level2",
  requireAuth,
  requireRole("citizen"),
  sosLimiter,
  sosValidation,
  handleValidationErrors,
  emergencyController.triggerLevel2,
);
router.post(
  "/api/emergency/level3",
  requireAuth,
  requireRole("citizen"),
  sosLimiter,
  sosValidation,
  handleValidationErrors,
  emergencyController.triggerLevel3,
);
router.get(
  "/api/emergency/nearby-alerts",
  requireAuth,
  emergencyController.getNearbyAlerts,
);
router.post(
  "/api/emergency/accept",
  requireAuth,
  emergencyController.acceptAlert,
);
router.post(
  "/api/emergency/cancel",
  requireAuth,
  emergencyController.cancelAlert,
);
router.post(
  "/trigger-sos",
  requireAuth,
  requireRole("citizen"),
  sosLimiter,
  sosValidation,
  handleValidationErrors,
  emergencyController.triggerLevel3,
);

module.exports = router;
