/**
 * Utility functions for location calculations
 * Uses efficient MongoDB geospatial queries
 */

/**
 * Calculate distance between two coordinates (Haversine formula)
 * Returns distance in kilometers
 * @param {Number} lat1, lon1, lat2, lon2
 * @returns {Number} distance in km
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * Convert meters to degrees (approximate)
 * Useful for geospatial queries
 * @param {Number} meters
 * @returns {Number} degrees
 */
function metersToDegreesLatitude(meters) {
  return meters / 111000; // 1 degree ≈ 111 km
}

/**
 * Validate coordinates
 * @param {Number} lat, lng
 * @returns {Boolean}
 */
function isValidCoordinates(lat, lng) {
  return (
    lat &&
    lng &&
    !isNaN(lat) &&
    !isNaN(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

/**
 * Center coordinates on India
 * @returns {Object} { lat, lng }
 */
function getIndiaCenter() {
  return { lat: 20.5937, lng: 78.9629 }; // Geographic center of India
}

module.exports = {
  calculateDistance,
  metersToDegreesLatitude,
  isValidCoordinates,
  getIndiaCenter,
};
