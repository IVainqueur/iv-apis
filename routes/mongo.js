const express = require("express");
const { default: mongoose } = require("mongoose");
const { connectToMongo } = require("../utils");
const router = express.Router();

// DRY helper to wrap route handlers with connect/disconnect logic
function withMongo(handler) {
  return async (req, res) => {
    try {
      await connectToMongo();
      await handler(req, res);
    } catch (error) {
      console.log(error);
      // If the handler doesn't handle errors, send a generic error
      if (!res.headersSent) {
        res.status(500).json({ message: "Internal server error", error });
      }
    } finally {
      try {
        await mongoose.connection.close();
        console.log("MongoDB connection closed after request");
      } catch (e) {}
    }
  };
}

// check if collection exists
router.get(
  "/check-collection",
  withMongo(async (req, res) => {
    const { collection } = req.query;
    const collectionExists = await mongoose.connection.db
      .listCollections({ name: collection.toLowerCase() })
      .toArray();
    res.json({ collectionExists });
  })
);

// create collection
router.post(
  "/create-collection",
  withMongo(async (req, res) => {
    const { collection: _collection, schema } = req.body;
    const collection = _collection.toLowerCase();

    // check if collection exists
    const collectionExists = await mongoose.connection.db
      .listCollections({ name: collection })
      .toArray();
    if (collectionExists.length > 0) {
      return res.status(400).json({ message: "Collection already exists" });
    }

    // create collection through mongoose schema
    mongoose.model(collection, schema);
    res.json({ message: "Collection created successfully" });
  })
);

// get all collections
router.get(
  "/get-collections",
  withMongo(async (req, res) => {
    const collections = await mongoose.connection.db
      .listCollections()
      .toArray();
    res.json({ collections });
  })
);

// add document to collection
router.post(
  "/add-document",
  withMongo(async (req, res) => {
    const { collection, document } = req.body;
    const collectionName = collection.toLowerCase();
    // Use the MongoDB collection API directly instead of mongoose model
    const result = await mongoose.connection.db
      .collection(collectionName)
      .insertOne(document);
    res.json({
      message: "Document added successfully",
      insertedId: result.insertedId,
    });
  })
);

// get all documents from collection
router.post(
  "/get-documents",
  withMongo(async (req, res) => {
    const { collection, filter } = req.body;
    const collectionName = collection.toLowerCase();
    
    // Use the provided filter or default to empty object
    const queryFilter = filter || {};
    
    const documents = await mongoose.connection.db
      .collection(collectionName)
      .find(queryFilter)
      .toArray();
    res.json({ documents });
  })
);


module.exports = router;
