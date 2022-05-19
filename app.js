const express = require('express')
const app = express()
const cors = require('cors')
const bodyParser = require('body-parser')
const {_pick, _remove, arr_remove} = require('./oneliners')
const nocorsRoute = require('./routes/nocors')


require('dotenv').config()
app.use(cors())
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({extended: true}))


app.use('/nocors', nocorsRoute)
app.use('*', (req, res)=>{
    console.log("[log] Undocumented route")
    res.send({code: "#Undocumented", message: "Nothing on this route yet"})
})


app.listen(process.env.PORT, ()=>{
    console.log("[log]: Server is up")
})