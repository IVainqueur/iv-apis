const express = require('express')
const app = express.Router()
const cors = require('cors')
const bodyParser = require('body-parser')
const mongo = require('mongoose')
const Photos = require('../models/ml-photos')
const Search = require('../models/ml-search')
const axios = require('axios')
const querystring = require('querystring')


app.use(cors())
app.use(bodyParser.json())
require('dotenv').config()

const RANDOM_PHOTOS_URL = `https://api.unsplash.com/photos/random?client_id=${process.env.CLIENT_ID}&count=20`
const RANDOM_TEXT_URL = `http://loripsum.net/api`

mongo.set('strictQuery', true)
mongo.connect(process.env.MONGO_URI, (err) => {
    if (err) return console.log('\x1B[31m\x1B[1m[LOG]: Failed to connect to DB\x1B[0m');
    console.log('\x1B[32m\x1B[1m[LOG] Connected to DB\x1B[0m')
})


app.get('/data', async (req, res) => {
    let today = Date.parse((new Date().toLocaleDateString('en-US', { timeZone: 'Africa/Harare' })))
    try {
        let todaysPhotos = await Photos.findOne({ date: { '$eq': today } })
        let { data: bio } = await axios.get(RANDOM_TEXT_URL)

        if (todaysPhotos) {
            let toSend = todaysPhotos.photos.map(x => ({ url: x.urls.regular, caption: x.description, likes: x.likes }))
            return res.json({ code: "#Success", data: { photos: toSend, bio: bio.match(/(<p>(.*){2,}<\/p>)\n/)[1] } })
        }
        let { data } = await axios.get(RANDOM_PHOTOS_URL)

        let toSend = data.map(x => ({ url: x.urls.regular, caption: x.description, likes: x.likes }))
        todaysPhotos = await Photos.findOne({ date: { '$eq': today } })
        if (todaysPhotos) return
        let input = Photos({
            date: today,
            photos: data
        });
        await input.save()

        res.json({ code: "#Success", data: { photos: toSend, bio: bio.match(/(<p>(.*){2,}<\/p>)\n/)[1] } });

    } catch (e) {
        console.log(e)
        res.json({ code: "#Error", message: e.message })
    }
})

app.get('/search', async (req, res) => {
    let query = req.query.q || false
    if (!query) return res.json({ code: "#Error", message: "parameter 'q' is needed" })
    let URL = `https://api.unsplash.com/search/photos?query=${query}&client_id=${process.env.CLIENT_ID}&per_page=30`;

    let today = Date.parse((new Date().toLocaleDateString('en-US', { timeZone: 'Africa/Harare' })))
    try {
        let todaysPhotos = await Search.findOne({ query })

        if (todaysPhotos) {
            let toSend = todaysPhotos.photos.map(x => ({ url: x.urls.regular, caption: x.description, likes: x.likes }))
            return res.json({ code: "#Success", data: { photos: toSend } })
        }
        let { data } = await axios.get(URL);
        data = data.results
        let toSend = data.map(x => ({ url: x.urls.regular, caption: x.description, likes: x.likes }))
        todaysPhotos = await Search.findOne({ query })
        if (todaysPhotos) return
        let input = Search({
            query,
            photos: data
        });
        await input.save()

        res.json({ code: "#Success", data: { photos: toSend } });

    } catch (e) {
        console.log(e)
        res.json({ code: "#Error", message: e.message })
    }
})

app.get('/random/:search', async (req, res) => {
    const search = req.params.search ?? '';
    const size = req.query.size ?? 'regular';
    const orientation = req.query.orientation ?? 'landscape';
    console.log(search, orientation, size);
    
    const URI = `https://api.unsplash.com/photos/random?query=${search}&client_id=${process.env.CLIENT_ID}&orientation=${orientation}`;
    try {
        const results = await axios.get(URI);
        const img = results.data.urls[size]
            ?? results.data.urls.thumb
            ?? results.data.urls.small
            ?? results.data.urls.regular
            ?? results.data.urls.full
            ?? results.data.urls.raw

        res.redirect(img)
    } catch (e) {
        res.redirect('https://via.placeholder.com/300?text=404')
    }

})


module.exports = app


