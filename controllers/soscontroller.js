exports.getSOSPage = (req, res) => {
  if (!req.session.isLoggedIn) {
    return res.redirect("/login");
  }

  res.render("sos", {
    pageTitle: "Emergency SOS System",
    isLoggedIn: req.session.isLoggedIn,
    userId: req.session.userId,
    userName: req.session.userName,
  });
};
