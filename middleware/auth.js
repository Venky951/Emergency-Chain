const User = require("../models/signup");

const isAuthenticated = (req, res, next) => {
  if (req.session && req.session.isLoggedIn && req.session.userId) {
    return next();
  }

  if (req.xhr || req.headers.accept?.includes("application/json")) {
    return res.status(401).json({ error: "Authentication required." });
  }

  return res.redirect("/login");
};

const requireAuth = isAuthenticated;

const requireGuest = (req, res, next) => {
  if (req.session && req.session.isLoggedIn) {
    return res.redirect("/dashboard");
  }

  return next();
};

const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    const userRole = req.user?.role || req.session?.userRole;

    if (!userRole) {
      if (req.xhr || req.headers.accept?.includes("application/json")) {
        return res.status(401).json({ error: "Authentication required." });
      }
      return res.redirect("/login");
    }

    if (!allowedRoles.includes(userRole)) {
      if (req.xhr || req.headers.accept?.includes("application/json")) {
        return res
          .status(403)
          .json({ error: "Forbidden: insufficient permissions." });
      }
      return res.status(403).render("error", {
        pageTitle: "Access denied",
        currentPage: "error",
        message: "You do not have permission to access this page.",
      });
    }

    return next();
  };
};

const attachUser = async (req, res, next) => {
  if (!req.session || !req.session.userId) {
    req.user = null;
    res.locals.user = null;
    return next();
  }

  try {
    const user = await User.findById(req.session.userId).select("-password");
    req.user = user;
    res.locals.user = user;
    res.locals.isLoggedIn = !!user;
    res.locals.userId = user?._id || null;
    res.locals.userRole = user?.role || req.session.userRole || null;
    res.locals.userName = user?.name || req.session.userName || null;
    return next();
  } catch (error) {
    req.user = null;
    res.locals.user = null;
    return next();
  }
};

module.exports = {
  requireAuth,
  requireGuest,
  requireRole,
  attachUser,
  isAuthenticated,
  isAuthenticatedView: requireAuth,
  isNotAuthenticated: requireGuest,
  authorizeRole: (...roles) => requireRole(...roles),
};
