const mongoose = require("mongoose");

const parseJson = (jsonString) => {
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    return {};
  }
};

const connectToMongo = async () => {
  try {
    console.log("Connecting to MongoDB...");
    mongoose.set("strictQuery", false);
    await mongoose.connect(process.env.MONGODB_URL);
    console.log("Connected to MongoDB");
  } catch (error) {
    console.log("Error connecting to MongoDB", error);
  }
};

const connectToDBMiddleware = async (req, res, next) => {
  await connectToMongo();
  next();
};

module.exports = {
  parseJson,
  connectToMongo,
  connectToDBMiddleware,
};
