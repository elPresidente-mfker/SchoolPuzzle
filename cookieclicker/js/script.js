let cookieCount = 0;
var cookieCounter = document.getElementById('cookieCounter')
let clickerCount = 0
let grandmaCount = 0

if (localStorage.getItem("cookies")) {
    cookieCountLocal = localStorage.getItem("cookies");
    cookieCount = localStorage.getItem("cookies");
    window.addEventListener("DOMContentLoaded", () => {
        document.getElementById("cookieCounter").innerHTML = "Cookies: " + cookieCountLocal;
    });
}

if (localStorage.getItem("clickerCount")) {
    clickerCountLocal = localStorage.getItem("clickerCount");
    clickerCount = localStorage.getItem("clickerCount");
    window.addEventListener("DOMContentLoaded", () => {
        document.getElementById("clickerCount").innerHTML = "Mice: " + clickerCountLocal;
    });
}

if (localStorage.getItem("grandmaCount")) {
    grandmaCountLocal = localStorage.getItem("grandmaCount");
    grandmaCount = localStorage.getItem("grandmaCount");
    window.addEventListener("DOMContentLoaded", () => {
        document.getElementById("grandmaCount").innerHTML = "You have " + grandmaCountLocal + " Grandmas";
    });
}

function cookieClick() {
    breakme: if (localStorage.getItem("clickerCount")) {
        var clickerBoost = parseInt(cookieCount) + parseInt(localStorage.getItem("clickerCount"))
        cookieCount = clickerBoost;
        localStorage.setItem("cookies", cookieCount);
        document.getElementById("cookieCounter").innerHTML = "Cookies: " + cookieCount;
        if (localStorage.getItem("grandmaCount")) {
            var grandmaBoost = parseInt(cookieCount) + parseInt(localStorage.getItem("clickerCount")) * 2
            cookieCount = grandmaBoost;
            localStorage.setItem("cookies", cookieCount);
            document.getElementById("cookieCounter").innerHTML = "Cookies: " + cookieCount;
        }
    } else {
        if (localStorage.getItem("grandmaCount")) {
            var grandmaBoost = parseInt(cookieCount) + parseInt(localStorage.getItem("grandmaCount")) * 2
            cookieCount = grandmaBoost;
            localStorage.setItem("cookies", cookieCount);
            document.getElementById("cookieCounter").innerHTML = "Cookies: " + grandmaBoost;
            break breakme;
        }
        cookieCount++;
        localStorage.setItem("cookies", cookieCount);
        document.getElementById("cookieCounter").innerHTML = "Cookies: " + cookieCount;
    }
}

function onPurchase(item) {
    if (item == 'clicker') {
        if (cookieCount > 9) {
            cookieCount -= 10;
            clickerCount++
            localStorage.setItem('clickerCount', clickerCount)
            localStorage.setItem("cookies", cookieCount);
            document.getElementById("clickerCount").innerHTML = "Mice: " + clickerCount;
            document.getElementById("cookieCounter").innerHTML = "Cookies: " + cookieCount;
        } else {
            document.getElementById('error').innerHTML = 'You dont have enough cookies'
        }
    }
    if (item == 'grandma') {
        if (cookieCount > 49) {
            cookieCount -= 50;
            grandmaCount++;
            localStorage.setItem('grandmaCount', grandmaCount)
            localStorage.setItem("cookies", cookieCount);
            document.getElementById("cookieCounter").innerHTML = "Cookies: " + grandmaCount;
            document.getElementById("grandmaCount").innerHTML = "Grandma: " + grandmaCount;
        } else {
            document.getElementById('grandmaError').innerHTML = 'You dont have enough cookies'
        }
    }
}
