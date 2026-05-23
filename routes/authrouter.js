const express = require("express");
const authrouter = express.Router();
const authcontroller = require("../controllers/authcontroller");

// Signup Routes
authrouter.get("/signup", authcontroller.getsignup);
authrouter.post("/signup", authcontroller.postSignup);

// Login Routes
authrouter.get("/login", authcontroller.getLogin);
authrouter.post("/login", authcontroller.postLogin);

// Logout Route
authrouter.post("/logout", authcontroller.postLogout);

module.exports = authrouter;