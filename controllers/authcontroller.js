const User = require("../models/signup");
const bcrypt = require("bcryptjs");

// Get Signup Page
exports.getsignup = (req, res, next) => {
  res.render("auth/signup", {
    pageTitle: "Sign Up",
    currentPage: "signup",
    isLoggedIn: req.session.isLoggedIn || false,
  });
};

// Post Signup - Create New User
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

    // Validate required fields
    if (
      !name ||
      !phone ||
      !email ||
      !password ||
      !confirmPassword ||
      !emergencyContact ||
      !role
    ) {
      return res.status(422).render("auth/signup", {
        pageTitle: "Sign Up",
        currentPage: "signup",
        errorMessage: "All fields are required",
        oldInput: { name, phone, email, emergencyContact, role },
      });
    }

    // Check if passwords match
    if (password !== confirmPassword) {
      return res.status(422).render("auth/signup", {
        pageTitle: "Sign Up",
        currentPage: "signup",
        errorMessage: "Passwords do not match",
        oldInput: { name, phone, email, emergencyContact, role },
      });
    }

    // Check password length
    if (password.length < 6) {
      return res.status(422).render("auth/signup", {
        pageTitle: "Sign Up",
        currentPage: "signup",
        errorMessage: "Password must be at least 6 characters",
        oldInput: { name, phone, email, emergencyContact, role },
      });
    }

    // Check if terms are agreed
    if (!termsAgreed) {
      return res.status(422).render("auth/signup", {
        pageTitle: "Sign Up",
        currentPage: "signup",
        errorMessage: "You must agree to the terms",
        oldInput: { name, phone, email, emergencyContact, role },
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(422).render("auth/signup", {
        pageTitle: "Sign Up",
        currentPage: "signup",
        errorMessage: "Email already registered",
        oldInput: { name, phone, email, emergencyContact, role },
      });
    }

    // Hash password with 10 salt rounds
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create new user
    const newUser = new User({
      name: name.trim(),
      phone: phone.trim(),
      email: email.toLowerCase().trim(),
      password: hashedPassword,
      emergencyContact: emergencyContact.trim(),
      role: role,
      termsAgreed: true,
    });

    // Save user to database
    await newUser.save();

    // Store user session
    req.session.isLoggedIn = true;
    req.session.userId = newUser._id;
    req.session.userRole = newUser.role;
    req.session.userName = newUser.name;

    // Redirect to home
    res.redirect("/");
  } catch (error) {
    console.error("Signup Error:", error);
    res.status(500).render("auth/signup", {
      pageTitle: "Sign Up",
      currentPage: "signup",
      errorMessage: "Something went wrong. Please try again.",
    });
  }
};

// Get Login Page
exports.getLogin = (req, res, next) => {
  res.render("auth/login", {
    pageTitle: "Login",
    currentPage: "login",
    isLoggedIn: req.session.isLoggedIn || false,
  });
};

// Post Login - Authenticate User
exports.postLogin = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // Validate inputs
    if (!email || !password) {
      return res.status(422).render("auth/login", {
        pageTitle: "Login",
        currentPage: "login",
        errorMessage: "Please provide email and password",
        oldInput: { email },
      });
    }

    // Find user by email and get password
    const user = await User.findOne({ email: email.toLowerCase() }).select(
      "+password"
    );

    if (!user) {
      return res.status(401).render("auth/login", {
        pageTitle: "Login",
        currentPage: "login",
        errorMessage: "Invalid email or password",
        oldInput: { email },
      });
    }

    // Compare passwords
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).render("auth/login", {
        pageTitle: "Login",
        currentPage: "login",
        errorMessage: "Invalid email or password",
        oldInput: { email },
      });
    }

    // Check if user is active
    if (!user.isActive) {
      return res.status(403).render("auth/login", {
        pageTitle: "Login",
        currentPage: "login",
        errorMessage: "Your account is inactive",
        oldInput: { email },
      });
    }

    // Store user session
    req.session.isLoggedIn = true;
    req.session.userId = user._id;
    req.session.userRole = user.role;
    req.session.userName = user.name;

    // Redirect to home
    res.redirect("/");
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).render("auth/login", {
      pageTitle: "Login",
      currentPage: "login",
      errorMessage: "Something went wrong. Please try again.",
    });
  }
};

// Post Logout
exports.postLogout = (req, res, next) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Logout Error:", err);
      return res.status(500).send("Error logging out");
    }
    res.redirect("/");
  });
};
