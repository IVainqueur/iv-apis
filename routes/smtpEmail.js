const app = require('express').Router()
const nodemailer = require("nodemailer");

require('dotenv').config()

async function sendResetPassword(from, to, subject, text, html) {

  let transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: false, 
    auth: {
      user: process.env.SMTP_USER, 
      pass: process.env.SMTP_PASSWORD, 
    },
  });

  let info = await transporter.sendMail({
    from: from, // sender address
    to: to, // list of receivers
    subject: subject, // Subject line
    text: text, // plain text body
    html: html, // html body
  });

  console.log("Message sent: %s", info.messageId);

}



app.post('/', ({body}, res)=>{
    try{
        let emailResponse = await sendResetPassword(body.from, body.to, body.subject, body.text, body.html);
        res.json({code: "#Success", result: emailResponse});
    }catch(e){
        console.log(e)
        res.json({code: "#Error", message: e.message})
    }
})

//PEGDV2XNHW77IDIG

module.exports = app