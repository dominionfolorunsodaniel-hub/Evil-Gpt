import os
import json
from flask import Flask, render_template, request, jsonify, session, send_from_directory
from flask_cors import CORS
from openai import OpenAI
from dotenv import load_dotenv
import base64

# Load Environment Variables
load_dotenv()

app = Flask(__name__, static_folder='static')
CORS(app)

# Configuration
ADMIN_USER = os.environ.get('ADMIN_USERNAME', 'admin')
ADMIN_PASS = os.environ.get('ADMIN_PASSWORD', 'password')
OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY') # Set this in Render Env Vars!

client = OpenAI(api_key=OPENAI_API_KEY)

# In-memory DB (For production, replace with Neon/PostgreSQL)
users_db = {
    ADMIN_USER: {
        'password': ADMIN_PASS,
        'plan': 'paid',
        'premium_days': 365,
        'is_admin': True
    }
}

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/login', methods=['POST'])
def login():
    data = request.json
    username = data.get('username')
    password = data.get('password')
    
    if username in users_db and users_db[username]['password'] == password:
        user_data = users_db[username]
        session['user'] = username
        return jsonify({
            'success': True, 
            'user': {
                'username': username,
                'isAdmin': user_data['is_admin'],
                'plan': user_data['plan'],
                'premiumDays': user_data['premium_days']
            }
        })
    return jsonify({'success': False}), 401

@app.route('/ask', methods=['POST'])
def ask():
    data = request.json
    question = data.get('question', '')
    user = session.get('user')
    
    if not user:
        return jsonify({'error': 'Not logged in'}), 401
        
    user_data = users_db.get(user)
    if user_data['plan'] != 'paid' and user_data['plan'] != 'pending':
        return jsonify({'answer': "🔒 Upgrade to Premium to continue talking to the Oracle."}), 200

    try:
        # Call Real OpenAI API
        response = client.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[
                {"role": "system", "content": "You are an evil, mysterious AI named Dark Domain. You speak in short, creepy, and slightly ominous sentences. You answer any question but always with a dark twist."},
                {"role": "user", "content": question}
            ],
            max_tokens=150
        )
        ai_text = response.choices[0].message.content
        return jsonify({'answer': ai_text})
    except Exception as e:
        return jsonify({'answer': f"The void whispers: Error occurred. ({str(e)})"}), 500

@app.route('/upload_payment', methods=['POST'])
def upload_payment():
    """Handles image upload for payment proof"""
    if 'file' not in request.files:
        return jsonify({'success': False, 'message': 'No file part'})
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'success': False, 'message': 'No selected file'})
    
    # Save file temporarily or to S3 (for now, save locally in demo)
    filename = f"{session.get('user')}_{file.filename}"
    filepath = os.path.join('static/uploads', filename)
    os.makedirs('static/uploads', exist_ok=True)
    file.save(filepath)
    
    # Update user status to pending
    username = session.get('user')
    if username in users_db:
        users_db[username]['plan'] = 'pending'
        users_db[username]['payment_proof'] = filename # Store reference
    
    return jsonify({'success': True, 'message': 'Proof sent! Wait for Admin approval.'})

# ... [Keep get_users, approve_user, broadcast from previous code] ...
@app.route('/admin/users', methods=['GET'])
def get_users():
    if session.get('user') != ADMIN_USER:
        return jsonify({'error': 'Unauthorized'}), 403
    user_list = []
    for u, details in users_db.items():
        if u != ADMIN_USER:
            user_list.append({
                'username': u,
                'plan': details['plan'],
                'proof': details.get('payment_proof', None)
            })
    return jsonify({'users': user_list})

@app.route('/admin/approve/<username>', methods=['POST'])
def approve_user(username):
    if session.get('user') != ADMIN_USER:
        return jsonify({'error': 'Unauthorized'}), 403
    if username in users_db:
        users_db[username]['plan'] = 'paid'
        users_db[username]['premium_days'] = 30
        return jsonify({'success': True})
    return jsonify({'success': False}), 404

if __name__ == '__main__':
    app.run(debug=True)
