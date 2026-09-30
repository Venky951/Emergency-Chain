const express = require("express");
const router = express.Router();

const sosController = require("../controllers/soscontroller");
const { requireAuth } = require("../middleware/auth");

router.get("/sos", requireAuth, sosController.getSOSPage);

module.exports = router;
