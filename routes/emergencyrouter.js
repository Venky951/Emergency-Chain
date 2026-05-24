const express = require("express");

const router = express.Router();

const emergencyController = require("../controllers/emergencycontroller");

router.post("/trigger-sos", emergencyController.triggerSOS);

module.exports = router;
