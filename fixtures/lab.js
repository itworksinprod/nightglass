const canvas = document.querySelector("#fixture-canvas");
const context = canvas.getContext("2d");
const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
gradient.addColorStop(0, "#f8d65c");
gradient.addColorStop(0.5, "#de4f75");
gradient.addColorStop(1, "#315fca");
context.fillStyle = gradient;
context.fillRect(0, 0, canvas.width, canvas.height);
context.fillStyle = "rgba(255, 255, 255, .9)";
context.font = "700 24px system-ui";
context.fillText("Canvas pixels", 24, 48);

const shadowHost = document.querySelector("#shadow-host");
const shadow = shadowHost.attachShadow({mode: "open"});
shadow.innerHTML = `
  <style>
    :host { display: block; }
    article { min-height: 185px; padding: 1rem; color: #243047; background: #eef7ff; border: 1px solid #bad9f3; border-radius: 12px; }
    p { color: #5b6c82; }
    button { min-height: 44px; color: #fff; background: #236899; border: 0; border-radius: 9px; padding: .6rem .9rem; }
  </style>
  <article>
    <strong>Open shadow root</strong>
    <p>Styles inside this component should be discovered and transformed.</p>
    <button type="button">Shadow action</button>
  </article>
`;

document.querySelector("#add-card").addEventListener("click", () => {
  const card = document.createElement("article");
  card.className = "card live-card";
  card.innerHTML = `
    <span class="badge success">Live</span>
    <h3>Inserted after load</h3>
    <p>The mutation observer should theme this card without a reload.</p>
    <a href="#">Inspect mutation</a>
  `;
  document.querySelector("#card-grid").append(card);

  const sheet = [...document.styleSheets].find((candidate) => candidate.href?.endsWith("lab.css"));
  try {
    sheet?.insertRule(".live-card { background: #f2fff7; border-color: #afe1c2; }", sheet.cssRules.length);
  } catch {
    // The fixture remains useful if a browser prevents mutation of this sheet.
  }
});
