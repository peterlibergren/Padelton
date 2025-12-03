const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3000; // vælg det portnummer du allerede bruger

app.use(express.json());
app.use(express.static("public")); // hvis dine html-filer ligger i ./public

