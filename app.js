const path = require("path");

const express = require("express");

const session = require("express-session");
const MongoStore = require("connect-mongodb-session");

const mongoUri =
  "mongodb+srv://heythere250105_db_user:malothvenky@emergencychain.oowwgs8.mongodb.net/emergencychain?retryWrites=true&w=majority";

const { default: mongoose } = require("mongoose");

const app = express();
app.set("view engine", "ejs");
app.set("views", "views");

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// MongoDB Connection
mongoose
  .connect(mongoUri)
  .then(() => {
    console.log("✅ MongoDB Connected Successfully");
  })
  .catch((err) => {
    console.error("❌ MongoDB Connection Error:", err);
  });

// Session Store
const MongoDBStore = MongoStore(session);
const sessionStore = new MongoDBStore({
  uri: mongoUri,
  collection: "sessions",
});

// Session Configuration
app.use(
  session({
    secret: "your-secret-key-change-this",
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      httpOnly: true,
    },
  }),
);

// Make session data available in views
app.use((req, res, next) => {
  res.locals.isLoggedIn = req.session.isLoggedIn || false;
  res.locals.userId = req.session.userId || null;
  res.locals.userRole = req.session.userRole || null;
  res.locals.userName = req.session.userName || null;
  next();
});

// Routes
const authRoutes = require("./routes/authrouter");
const locationRoutes = require("./routes/locationrouter");
const emergencyRoutes = require("./routes/emergencyrouter");
app.get("/", (req, res) => {
  res.render("index", {
    pageTitle: "Home - EmergencyChain",
    currentPage: "home",
  });
});

app.use(authRoutes);
app.use(locationRoutes);
app.use(emergencyRoutes);
// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).render("error", {
    message: err.message,
    error: err,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).render("error", {
    message: "Page not found",
    error: { status: 404 },
  });
});

// Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
