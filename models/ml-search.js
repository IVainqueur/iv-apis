const mongo = require('mongoose')

const searchSchema = mongo.Schema({
    query: String,
    photos: Array
})

module.exports = mongo.model('search', searchSchema)