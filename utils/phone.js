const normalizePhone = (value) => {
  const rawPhone = String(value ?? "").trim();
  const normalizedPhone = rawPhone.replace(/[()\s.-]/g, "").replace(/^00/, "+");

  if (!/^\+?[1-9]\d{6,14}$/.test(normalizedPhone)) {
    return null;
  }

  return normalizedPhone;
};

module.exports = { normalizePhone };
