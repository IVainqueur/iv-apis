const express = require("express");
const app = express.Router();
const { _pick, _remove, arr_remove } = require("../oneliners");
const fetch = require("node-fetch");
const { default: axios } = require("axios");
const request = require("request");
const multer = require("multer");
const FormData = require("form-data");

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
    headers: body.headers || {},
  };

  // Handle different content types
  const contentType = req.headers["content-type"] || "";
  
  if (contentType.includes("multipart/form-data")) {
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

    options.body = formData;
    options.headers = {
      ...options.headers,
      ...formData.getHeaders()
    };
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    const formData = new URLSearchParams();
    Object.keys(req.body).forEach(key => {
      if (key !== "headers" && key !== "method" && key !== "url" && key !== "body") {
        formData.append(key, req.body[key]);
      }
    });
    options.body = formData.toString();
    options.headers["content-type"] = "application/x-www-form-urlencoded";
  } else {
    // Handle JSON data as before
    options.body = JSON.stringify(body.body);
  }

  // console.log("Request options:", options);
  let response;
  try {
    response = await fetch(body.url, options);
  } catch (e) {
    return res.status(500).json({ code: "#Error", message: e.message });
  }

  let headers = {};
  for (let pair of response.headers.entries()) {
    headers[pair[0]] = pair[1];
  }

  let data = await response.text();
  try {
    let toSend = JSON.parse(data);
    res.send({ data: toSend, isJson: true, headers });
  } catch (e) {
    res.send({
      data,
      isJson: false,
      headers
    });
  }
});

app.all("/_/*", (req, res) => {
  const url = req.originalUrl.slice("/nocors/_/".length).replace(/%20/g, "");

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
