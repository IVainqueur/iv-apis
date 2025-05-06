const express = require("express");
const app = express.Router();
const { _pick, _remove, arr_remove } = require("../oneliners");
const { default: axios } = require("axios");
const request = require("request");
const multer = require("multer");
const FormData = require("form-data");
const { parseJson } = require("../utils");

// Configure multer for handling multipart form data
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
});

app.post("/", upload.any(), async (req, res) => {
  let body = _pick(["headers", "method", "url", "body"], req.body);
  let options = {
    method: body.method ? body.method : "GET",
    headers: typeof body.headers === "string" ? parseJson(body.headers) : body.headers || {},
    maxContentLength: 50 * 1024 * 1024, // 50MB limit
    timeout: 30000, // 30 seconds timeout
    validateStatus: function (status) {
      return status >= 200 && status < 500; // Accept all status codes less than 500
    }
  };

  // Handle different content types
  const contentType = req.headers["content-type"] || "";
  
  if (contentType.includes("multipart/form-data")) {
    try {
      const formData = new FormData();
      
      // Add files from multer
      if (req.files && req.files.length > 0) {
        req.files.forEach(file => {
          formData.append(file.fieldname, file.buffer, {
            filename: file.originalname,
            contentType: file.mimetype
          });
        });
      }
      
      // Add regular form fields
      Object.keys(req.body).forEach(key => {
        if (key !== "headers" && key !== "method" && key !== "url" && key !== "body") {
          formData.append(key, req.body[key]);
        }
      });

      // Use axios's native FormData support
      options.data = formData;
      options.headers = {
        ...options.headers,
        ...formData.getHeaders()
      };

    } catch (formDataError) {
      console.error('FormData processing error:', formDataError);
      return res.status(500).json({
        code: "#Error",
        message: "Error processing form data",
        details: formDataError.message
      });
    }

  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    const formData = new URLSearchParams();
    Object.keys(req.body).forEach(key => {
      if (key !== "headers" && key !== "method" && key !== "url" && key !== "body") {
        formData.append(key, req.body[key]);
      }
    });
    options.data = formData.toString();
    options.headers["Content-Type"] = "application/x-www-form-urlencoded";
  } else {
    // Handle JSON data
    options.data = body.body;
    if (options.data && typeof options.data === 'object') {
      options.headers["Content-Type"] = "application/json";
    }
  }

  try {
    const response = await axios(body.url, options);
    
    // Convert axios response headers to a simple object
    const headers = {};
    Object.keys(response.headers).forEach(key => {
      headers[key] = response.headers[key];
    });

    // Check if the response data is JSON
    let isJson = false;
    let data = response.data;
    
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
        isJson = true;
      } catch (e) {
        // If parsing fails, data remains a string
      }
    } else {
      isJson = true;
    }

    res.send({ 
      data, 
      isJson, 
      headers,
      status: response.status,
      statusText: response.statusText
    });
  } catch (error) {
    console.error('Request failed:', error.message);
    
    if (error.code === 'ECONNABORTED') {
      // Handle timeout error
      res.status(504).json({
        code: "#Error",
        message: "Request timeout",
        details: "The request took too long to complete",
        timeout: options.timeout
      });
    } else if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      res.status(error.response.status).json({
        code: "#Error",
        message: error.message,
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data,
        requestHeaders: options.headers,
        requestData: options.data
      });
    } else if (error.request) {
      // The request was made but no response was received
      res.status(500).json({
        code: "#Error",
        message: "No response received from server",
        details: error.message,
        requestHeaders: options.headers,
        requestData: options.data
      });
    } else {
      // Something happened in setting up the request that triggered an Error
      res.status(500).json({
        code: "#Error",
        message: "Error setting up request",
        details: error.message,
        requestHeaders: options.headers,
        requestData: options.data
      });
    }
  }
});

app.all("/_/*", (req, res) => {
  const url = decodeURIComponent(req.originalUrl.slice("/nocors/_/".length).replace(/%20/g, ""));

  request(
    {
      url: url,
      method: req.method,
      json: req.body,
      headers: {
        Authorization: req.header("Authorization"),
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36",
      },
      timeout: 10000,
      withCredentials: true,
      
    },
    function (error, response, body) {
      if (error) {
        console.error("📢 error: " + error);
      }
    }
  ).pipe(res);
});

module.exports = app;
