/**
 * Logging and Error Handling Utilities
 * Production-ready error tracking
 */

const fs = require("fs");
const path = require("path");

// Ensure logs directory exists
const logsDir = path.join(__dirname, "../logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

/**
 * Format log message with timestamp
 */
function formatLogMessage(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  return {
    timestamp,
    level,
    message,
    data,
  };
}

/**
 * Log to file
 */
function logToFile(filename, logEntry) {
  const filepath = path.join(logsDir, filename);
  const logLine = JSON.stringify(logEntry) + "\n";
  fs.appendFileSync(filepath, logLine, "utf8");
}

/**
 * Log info
 */
const logInfo = (message, data = {}) => {
  const entry = formatLogMessage("INFO", message, data);
  console.log(`[INFO] ${message}`, data);
  logToFile("app.log", entry);
};

/**
 * Log errors
 */
const logError = (message, error, data = {}) => {
  const entry = formatLogMessage("ERROR", message, {
    ...data,
    error: error.message,
    stack: error.stack,
  });
  console.error(`[ERROR] ${message}`, error);
  logToFile("error.log", entry);
};

/**
 * Log SOS events
 */
const logSOS = (userId, level, latitude, longitude, data = {}) => {
  const entry = formatLogMessage("SOS", `Level ${level} triggered`, {
    userId,
    level,
    ...data,
  });
  console.log(`[SOS] Level ${level} from user ${userId}`);
  logToFile("sos.log", entry);
};

/**
 * Log location updates
 */
const logLocation = (userId, latitude, longitude) => {
  const entry = formatLogMessage("LOCATION", "Location updated", {
    userId,
  });
  logToFile("location.log", entry);
};

/**
 * Log authentication events
 */
const logAuth = (userId, action, data = {}) => {
  const entry = formatLogMessage("AUTH", action, {
    userId,
    ...data,
  });
  console.log(`[AUTH] ${action} - User: ${userId}`);
  logToFile("auth.log", entry);
};

/**
 * Custom error class
 */
class AppError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Async error wrapper
 * Wraps async route handlers to catch errors
 */
const catchAsync = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Global error handler middleware
 */
const errorHandler = (err, req, res, next) => {
  logError(err.message, err, {
    url: req.url,
    method: req.method,
    userId: req.session?.userId,
  });

  const statusCode = err.statusCode || 500;
  const safeMessage =
    process.env.NODE_ENV === "production"
      ? "Something went wrong. Please try again later."
      : err.message || "Internal Server Error";

  if (req.accepts("html")) {
    return res.status(statusCode).render("error", {
      pageTitle: "Error",
      currentPage: "error",
      message: safeMessage,
      error: {
        status: statusCode,
      },
      isLoggedIn: !!req.session?.isLoggedIn,
    });
  }

  return res.status(statusCode).json({
    error: safeMessage,
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  });
};

module.exports = {
  logInfo,
  logError,
  logSOS,
  logLocation,
  logAuth,
  AppError,
  catchAsync,
  errorHandler,
};
