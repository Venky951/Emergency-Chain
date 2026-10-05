const express = require("express");
const rateLimit = require("express-rate-limit");
const { body, validationResult } = require("express-validator");
const authrouter = express.Router();
const authcontroller = require("../controllers/authcontroller");
const { requireGuest } = require("../middleware/auth");

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many login attempts. Please wait a moment and try again.",
  },
});

const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many signup attempts. Please wait a moment and try again.",
  },
});

const renderValidationErrors = (viewName, title) => (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const firstError = errors.array()[0].msg;
    return res.status(422).render(viewName, {
      pageTitle: title,
      currentPage: viewName.includes("login") ? "login" : "signup",
      errorMessage: firstError,
      oldInput: req.body,
    });
  }
  return next();
};

authrouter.get("/signup", requireGuest, authcontroller.getsignup);
authrouter.post(
  "/signup",
  signupLimiter,
  [
    body("name")
      .trim()
      .isLength({ min: 2 })
      .withMessage("Full name must be at least 2 characters."),
    body("phone").trim().notEmpty().withMessage("Phone is required."),
    body("email")
      .isEmail()
      .withMessage("Please provide a valid email address."),
    body("password")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters."),
    body("confirmPassword").custom((value, { req }) => {
      if (value !== req.body.password) {
        throw new Error("Passwords do not match.");
      }
      return true;
    }),
    body("emergencyContact")
      .trim()
      .notEmpty()
      .withMessage("Emergency contact is required."),
    body("termsAgreed")
      .equals("on")
      .withMessage("You must agree to the terms."),
  ],
  renderValidationErrors("auth/signup", "Sign Up"),
  authcontroller.postSignup,
);

authrouter.get("/login", requireGuest, authcontroller.getLogin);
authrouter.post(
  "/login",
  loginLimiter,
  [
    body("email")
      .isEmail()
      .withMessage("Please provide a valid email address."),
    body("password").notEmpty().withMessage("Password is required."),
  ],
  renderValidationErrors("auth/login", "Login"),
  authcontroller.postLogin,
);

authrouter.post("/logout", authcontroller.postLogout);

module.exports = authrouter;
