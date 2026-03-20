// Updated detectDisplayName function to handle non-string input and multipart content from file attachments.

function detectDisplayName(userText) {
    // Convert userText to string if it's not already.
    userText = String(userText);

    // Existing logic for detecting display name...
}

function extractUserText(message) {
    let text = '';
    if (message.attachments) {
        message.attachments.forEach(attachment => {
            // Handle multipart content, extract text from each attachment if necessary
            text += attachment.content ? attachment.content : '';
        });
    }
    return text;
}

// Other code in chat.js...