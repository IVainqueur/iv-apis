const express = require('express')
const app = express()
const cors = require('cors')
const bodyParser = require('body-parser')
const {_pick, _remove, arr_remove} = require('./oneliners')
const nocorsRoute = require('./routes/nocors')
const emailRoute = require('./routes/smtpEmail')
const anonymousRoute = require('./routes/anonymous')

/* =============== SWAGGERS ================ */
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./swaggers/ekosora/swagger.json');
const swaggerOptions = {
    explorer: true,
    customJs: '/customSwaggerjs.js',
    customCssUrl: '/swaggers/ekosora/customSwaggerCss.css'
}
app.get("/customSwaggerjs.js", (req, res)=>{
    res.sendFile(__dirname + '/swaggers/ekosora/customSwaggerjs.js')
})
app.get("/customSwaggerCss.css", (req, res)=>{
    res.sendFile(__dirname + '/swaggers/ekosora/customSwaggerCss.css')
})
app.get('/api/docs/favicon-32x32.png', (req, res)=>{
    return res.sendFile(__dirname+'/swaggers/ekosora/favicon.png')
})
app.get('/api/docs/favicon-16x16.png', (req, res)=>{
    return res.sendFile(__dirname+'/swaggers/ekosora/favicon.png')
})
app.use('/ekosora/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, swaggerOptions))

/* ============= MIDDLEWARE ============== */

require('dotenv').config()
app.use(cors())
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({extended: true}))


app.use('/nocors', nocorsRoute)
app.use('/sendMail', emailRoute)
app.use('/anonymous', anonymousRoute)

app.use('*', (req, res)=>{
    console.log("[log] Undocumented route")
    res.send({code: "#Undocumented", message: "Nothing on this route yet"})
})


app.listen(process.env.PORT, ()=>{
    console.log("[log]: Server is up at PORT ", process.env.PORT)
})