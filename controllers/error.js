exports.pageNotFound = (req, res, next) => {
  res.status(404).render("eroor", {
    pageTitle: "Page Not Found",
    currentPage: "404",
    isLoggedIn: req.isLoggedIn,
  });
};
