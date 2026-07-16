#  <link href="https://cdn.jsdelivr.net/npm/@n8n/chat/dist/style.css" rel="stylesheet" />

# <style>
#   :root {
#     --chat--border-radius: 24px;
#     --chat--message--border-radius: 20px;
#     --chat--toggle--size: 64px;
#   }
# </style>

# <script type="module">
#   import { createChat } from 'https://cdn.jsdelivr.net/npm/@n8n/chat/dist/chat.bundle.es.js';
#   createChat({
#     webhookUrl: 'https://hamzah20.app.n8n.cloud/webhook/1d3462fa-05c8-456d-b7d2-7c8e9f18bf47/chat'
#   });
# </script>





<!DOCTYPE html>

<html lang="en">

<head>

    <meta charset="utf-8">

    <meta name="viewport" content="width=device-width, initial-scale=1">

    <title>Busterzworld</title>

</head>

<body style="background-color: lightcyan;">


    <h1 style="color:red; font-family:verdana; background-color: blue; border: 5px solid red;">

        <strong> Hello, my name is Vivaan and I am the founder of Busterz World. </strong>

    </h1>


    <h2 style="color: blueviolet; font-family: monospace; background-color: lightgoldenrodyellow; border: 5px solid orange;">

        I have always wanted a business and now it is ready.

    </h2>


    <footer style="background-color:yellow;border: 5px solid black;">

        <h1 style="font-family: verdana;">

            This is obviously not my website but I am trying to learn how to code.

        </h1>

    </footer>


    <br><br>


    <button type="button" onclick="undoClick()" style="background-color: gray; color: white; font-size: 10px;">Back</button>

    <div style="width: 6px; height: 55px; background-color: red; margin-left: 37px;"></div>

    <div style="width: 0; height: 0; border-left: 10px solid transparent; border-right: 10px solid transparent; border-top: 18px solid red; margin-left: 28px;"></div>


    <br><br>


    <button type="button" onclick="myFunctions()" style="background-color: blue; color: lime;">Click Me!</button>

    <p id="demo" style="display: inline-block; margin-left: 10px; border: 5px solid black; color: yellow; font-family: verdana; background-color: blue; padding: 10px; vertical-align: middle;">

        <em> I tried making something. </em>

    </p>

    <p style="display: inline-block; margin-left: 10px; font-size: 12px; vertical-align: middle;">

        Click the Click Me button

    </p>


    <br><br>


    <button type="button" onclick="showBag()" style="background-color: green; color: white;">Show Shopping Bag</button>

    <button type="button" onclick="hideBag()" style="background-color: gray; color: white;">Back</button>


    <p id="bag" style="display: none; font-size: 50px; margin-top: 20px;">🛍️ Shopping Bag</p>


    <script>

        function myFunctions(){

            document.getElementById("demo").innerHTML = "<em>I made this from scratch</em>";

        }


        function undoClick(){

            document.getElementById("demo").innerHTML = "<em>I tried making something.</em>";

        }


        function showBag(){

            document.getElementById("bag").style.display = "block";

        }


        function hideBag(){

            document.getElementById("bag").style.display = "none";

        }

    </script>


</body>

</html>