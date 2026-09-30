const User = require("../models/signup");
const bcrypt = require("bcryptjs");

const sanitizeRole = (roleValue) => {
  const allowedRoles = ["citizen"];
  return allowedRoles.includes(roleValue) ? roleValue : "citizen";
};

exports.getsignup = (req, res, next) => {
  res.render("auth/signup", {
    pageTitle: "Sign Up",
    currentPage: "signup",
    isLoggedIn: !!req.session?.isLoggedIn,
  });
};

exports.postSignup = async (req, res, next) => {
  try {
    const {
      name,
      phone,
      email,
      password,
      confirmPassword,
      emergencyContact,
      role,
      termsAgreed,
    } = req.body;

    if (
      !name ||
      !phone ||
      !email ||
      !password ||
      !confirmPassword ||
      !emergencyContact
    ) {
      return res.status(422).render("auth/signup", {
        pageTitle: "Sign Up",
        currentPage: "signup",
        errorMessage: "All required fields must be completed.",
        oldInput: { name, phone, email, emergencyContact, role },
      });
    }

    if (password !== confirmPassword) {
      return res.status(422).render("auth/signup", {
        pageTitle: "Sign Up",
        currentPage: "signup",
        errorMessage: "Passwords do not match.",
        oldInput: { name, phone, email, emergencyContact, role },
      });
    }

    if (!termsAgreed) {
      return res.status(422).render("auth/signup", {
        pageTitle: "Sign Up",
        currentPage: "signup",
        errorMessage: "You must agree to the terms.",
        oldInput: { name, phone, email, emergencyContact, role },
      });
    }

    const normalizedRole = sanitizeRole(role);
    const existingUser = await User.findOne({
      email: email.toLowerCase().trim(),
    });
    if (existingUser) {
      return res.status(422).render("auth/signup", {
        pageTitle: "Sign Up",
        currentPage: "signup",
        errorMessage: "Email already registered.",
        oldInput: {
          name,
          phone,
          email,
          emergencyContact,
          role: normalizedRole,
        },
      });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({
      name: name.trim(),
      phone: phone.trim(),
      email: email.toLowerCase().trim(),
      password: hashedPassword,
      emergencyContact: emergencyContact.trim(),
      role: normalizedRole,
      termsAgreed: true,
    });

    await newUser.save();

    req.session.isLoggedIn = true;
    req.session.userId = newUser._id;
    req.session.userRole = newUser.role;
    req.session.userName = newUser.name;

    res.redirect("/dashboard");
  } catch (error) {
    console.error("Signup Error:", error);
    res.status(500).render("auth/signup", {
      pageTitle: "Sign Up",
      currentPage: "signup",
      errorMessage: "Something went wrong. Please try again.",
    });
  }
};

exports.getLogin = (req, res, next) => {
  res.render("auth/login", {
    pageTitle: "Login",
    currentPage: "login",
    isLoggedIn: !!req.session?.isLoggedIn,
  });
};

exports.postLogin = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(422).render("auth/login", {
        pageTitle: "Login",
        currentPage: "login",
        errorMessage: "Please provide email and password.",
        oldInput: { email },
      });
    }

    const user = await User.findOne({
      email: email.toLowerCase().trim(),
    }).select("+password");

    if (!user) {
      return res.status(401).render("auth/login", {
        pageTitle: "Login",
        currentPage: "login",
        errorMessage: "Invalid email or password.",
        oldInput: { email },
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).render("auth/login", {
        pageTitle: "Login",
        currentPage: "login",
        errorMessage: "Invalid email or password.",
        oldInput: { email },
      });
    }

    if (!user.isActive) {
      return res.status(403).render("auth/login", {
        pageTitle: "Login",
        currentPage: "login",
        errorMessage: "Your account is inactive.",
        oldInput: { email },
      });
    }

    req.session.isLoggedIn = true;
    req.session.userId = user._id;
    req.session.userRole = user.role;
    req.session.userName = user.name;

    res.redirect("/dashboard");
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).render("auth/login", {
      pageTitle: "Login",
      currentPage: "login",
      errorMessage: "Something went wrong. Please try again.",
    });
  }
};

exports.postLogout = (req, res, next) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Logout Error:", err);
      return res.status(500).send("Error logging out");
    }
    res.clearCookie("emergencychain.sid", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
    res.redirect("/");
  });
};
