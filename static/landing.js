(function () {
  var facts = [
    "Nigeria has over 220 million people and one of the youngest populations on earth.",
    "A good system prompt is just clear instructions written in plain English.",
    "AI language models predict the next word, one piece at a time, thousands of times a second.",
    "Lagos is one of the fastest-growing cities in the world.",
    "The first chatbot, ELIZA, was built in 1966 and just rephrased what you typed.",
    "Asking an AI to 'think step by step' often gives you a better answer.",
  ];
  var el = document.getElementById("daily-fact");
  if (el) { var d = new Date(); var i = (d.getFullYear() * 1000 + d.getMonth() * 31 + d.getDate()) % facts.length; el.textContent = "Did you know? " + facts[i]; }
})();
