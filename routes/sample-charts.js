const app = require("express").Router();

// Bar chart sample: number of signups per day
app.get("/bar", (req, res) => {
  const data = [
    { date: "2024-06-01", signups: 12 },
    { date: "2024-06-02", signups: 18 },
    { date: "2024-06-03", signups: 9 },
    { date: "2024-06-04", signups: 15 },
    { date: "2024-06-05", signups: 22 },
    { date: "2024-06-06", signups: 7 },
    { date: "2024-06-07", signups: 14 },
  ];
  res.json({ code: "#Success", data });
});

// Pie chart sample: number of admin users vs normal users
app.get("/pie", (req, res) => {
  const data = [
    { label: "Admin Users", value: 5 },
    { label: "Normal Users", value: 45 },
  ];
  res.json({ code: "#Success", data });
});

// Table chart sample: user list
app.get("/table", (req, res) => {
  const data = [
    { id: 1, name: "Alice", role: "Admin", email: "alice@example.com" },
    { id: 2, name: "Bob", role: "User", email: "bob@example.com" },
    { id: 3, name: "Charlie", role: "User", email: "charlie@example.com" },
  ];
  res.json({ code: "#Success", data });
});

// Card sample: summary stats
app.get("/card", (req, res) => {
  const data = [
    { title: "Total Users", value: 50 },
    { title: "Active Users", value: 38 },
    { title: "Admins", value: 7 },
    { title: "Signups Today", value: 6 },
  ];
  res.json({ code: "#Success", data });
});

module.exports = app;
