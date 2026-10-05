const express = require("express");
const rateLimit = require("express-rate-limit");
const { requireAuth, requireRole } = require("../middleware/auth");
const emergencyContactController = require("../controllers/emergencycontactcontroller");

const router = express.Router();
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many contact changes. Please try again later." },
});

const citizenOnly = [requireAuth, requireRole("citizen"), contactLimiter];

router.get(
  "/api/emergency-contacts",
  ...citizenOnly,
  emergencyContactController.listContacts,
);
router.post(
  "/api/emergency-contacts",
  ...citizenOnly,
  emergencyContactController.createContact,
);
router.patch(
  "/api/emergency-contacts/:id",
  ...citizenOnly,
  emergencyContactController.updateContact,
);
router.delete(
  "/api/emergency-contacts/:id",
  ...citizenOnly,
  emergencyContactController.deactivateContact,
);

module.exports = router;
