const isStateChangingMethod = (method) =>
  ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());

const getRequestOrigin = (req) => {
  const forwardedProtocol = req.get("x-forwarded-proto")?.split(",")[0].trim();
  return `${forwardedProtocol || req.protocol}://${req.get("host")}`;
};

const sameOrigin = (req, res, next) => {
  if (!isStateChangingMethod(req.method)) return next();

  const expectedOrigin = getRequestOrigin(req);
  const origin = req.get("origin");
  const referer = req.get("referer");
  let requestOrigin = origin;

  if (!requestOrigin && referer) {
    try {
      requestOrigin = new URL(referer).origin;
    } catch {
      requestOrigin = null;
    }
  }

  if (requestOrigin !== expectedOrigin) {
    return res.status(403).json({ error: "Cross-origin request rejected." });
  }

  return next();
};

module.exports = { sameOrigin };
