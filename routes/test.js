const express = require('express');
const router = express.Router();
const multer = require('multer');

// Configure multer for handling file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    }
});

// POST endpoint that accepts multipart form data
router.post('/upload', upload.single('file'), (req, res) => {
    // Log the file details
    if (req.file) {
        console.log('Received file:', {
            filename: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size
        });
    }

    // Log other form fields
    console.log('Form fields:', req.body);

    // Send response with body and headers
    res.json({
        success: true,
        body: req.body,
        headers: req.headers,
        file: req.file ? {
            filename: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size
        } : null
    });
});

module.exports = router; 