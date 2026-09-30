exports.pageNotFound = (req, res, next) => {
  res.status(404).render("error", {
    pageTitle: "Page Not Found",
    currentPage: "404",
    message: "The page you are trying to access does not exist.",
    isLoggedIn: !!req.session?.isLoggedIn,
  });
};
