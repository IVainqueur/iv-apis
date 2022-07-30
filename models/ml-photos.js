const mongo = require('mongoose')

const photosSchema = mongo.Schema({
    date: {
        type: Number,
        default: Date.parse(Date(new Date().toLocaleDateString('en-UK', {timeZone: 'Africa/Harare'})))
    },
    photos: Array
})


module.exports = mongo.model('photos', photosSchema)