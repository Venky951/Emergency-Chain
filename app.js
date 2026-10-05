require("dotenv").config();

const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const http = require("http");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");
const session = require("express-session");
const MongoStore = require("connect-mongodb-session")(session);
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { errorHandler, logInfo, logError } = require("./utils/logger");
const { attachUser, requireAuth } = require("./middleware/auth");
const User = require("./models/signup");
const Emergency = require("./models/emergency");
const EmergencyAlert = require("./models/emergencyAlert");
const EmergencyHistory = require("./models/emergencyhistory");

async function resolveMongoUri() {
  if (process.env.MONGODB_URI) {
    return process.env.MONGODB_URI;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("MONGODB_URI is not set. Startup aborted.");
  }

  const memoryServer = await MongoMemoryServer.create();
  logInfo("Using in-memory MongoDB for local development");
  return memoryServer.getUri();
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: [
          "'self'",
          "data:",
          "blob:",
          "https://*.tile.openstreetmap.org",
          "https://tile.openstreetmap.org",
        ],
        fontSrc: ["'self'"],
        connectSrc: ["'self'", "ws:", "wss:"],
        childSrc: ["'self'"],
        objectSrc: ["'none'"],
      },
    },
  }),
);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(bodyParser.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many signup attempts. Please try again later." },
});

const sosLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many SOS requests. Please slow down." },
});

async function startApp() {
  const mongoUri = await resolveMongoUri();
  const sessionStore = new MongoStore({
    uri: mongoUri,
    collection: "sessions",
  });

  sessionStore.on("error", (error) => {
    logError("Session store connection error", error);
  });

  const sessionMiddleware = session({
    secret:
      process.env.SESSION_SECRET || "development-session-secret-change-me",
    name: "emergencychain.sid",
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  });

  app.use(sessionMiddleware);
  io.engine.use(sessionMiddleware);

  app.use((req, res, next) => {
    res.locals.isLoggedIn = !!req.session?.isLoggedIn;
    res.locals.userId = req.session?.userId || null;
    res.locals.userRole = req.session?.userRole || null;
    res.locals.userName = req.session?.userName || null;
    next();
  });

  app.use(attachUser);

  const authRoutes = require("./routes/authrouter");
  const locationRoutes = require("./routes/locationrouter");
  const emergencyRoutes = require("./routes/emergencyrouter");
  const sosRoutes = require("./routes/sosrouter");

  require("./controllers/emergencycontroller").setIO(io);

  app.get("/", (req, res) => {
    res.render("index", {
      pageTitle: "Home - EmergencyChain",
      currentPage: "home",
    });
  });

  app.get("/dashboard", requireAuth, (req, res) => {
    res.render("dashboard", {
      pageTitle: "Dashboard - EmergencyChain",
      currentPage: "dashboard",
      userName: req.session.userName,
      user: req.user,
    });
  });

  app.use(authRoutes);
  app.use(locationRoutes);
  app.use(emergencyRoutes);
  app.use(sosRoutes);

  app.use((req, res) => {
    res.status(404).render("error", {
      pageTitle: "Page not found",
      currentPage: "error",
      message: "The page you requested could not be found.",
    });
  });

  app.use(errorHandler);

  const PORT = Number(process.env.PORT || 3000);

  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 5000,
  });

  await Promise.all([
    User.createIndexes(),
    Emergency.createIndexes(),
    EmergencyAlert.createIndexes(),
    EmergencyHistory.createIndexes(),
  ]);
  logInfo("MongoDB Connected Successfully");

  server.listen(PORT, "0.0.0.0", () => {
    logInfo(`Server running on http://localhost:${PORT}`);
  });
}

startApp().catch((error) => {
  logError("Application startup failed", error);
  process.exit(1);
});
