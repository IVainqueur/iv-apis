const express = require("express");
const { default: mongoose } = require("mongoose");
const router = express.Router();

// check if collection exists
router.get("/check-collection", async (req, res) => {
  try {
    const { collection } = req.query;
    const collectionExists = await mongoose.connection.db
      .listCollections({ name: collection.toLowerCase() })
      .toArray();
    res.json({ collectionExists });
  } catch (error) {
    res.status(500).json({ message: "Error checking collection", error });
  }
});

// create collection
router.post("/create-collection", async (req, res) => {
  try {
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
  } catch (error) {
    res.status(500).json({ message: "Error creating collection", error });
  }
});

// get all collections
router.get("/get-collections", async (req, res) => {
  try {
    const collections = await mongoose.connection.db
      .listCollections()
      .toArray();
    res.json({ collections });
  } catch (error) {
    res.status(500).json({ message: "Error getting collections", error });
  }
});

// add document to collection
router.post("/add-document", async (req, res) => {
  try {
    const { collection, document } = req.body;
    const collectionName = collection.toLowerCase();
    
    // Use the MongoDB collection API directly instead of mongoose model
    const result = await mongoose.connection.db
      .collection(collectionName)
      .insertOne(document);
    
    res.json({ 
      message: "Document added successfully", 
      insertedId: result.insertedId 
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Error adding document", error });
  }
});
module.exports = router;
