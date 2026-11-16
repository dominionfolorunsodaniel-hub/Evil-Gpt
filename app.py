import os
from flask import Flask, render_template, request, jsonify, session
from flask_cors import CORS

app = Flask(__name__)
CORS(app)
app.secret_key = os.environ.get('SECRET_KEY', 'supersecret')

# Admin Credentials from Environment Variables
ADMIN_USER = os.environ.get('ADMIN_USERNAME', 'admin')
ADMIN_PASS = os.environ.get('ADMIN_PASSWORD', 'password')

# In-memory database for demo (Replace with Neon DB in production)
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

@app.route('/register', methods=['POST'])
def register():
    data = request.json
    username = data.get('username')
    email = data.get('email')
    password = data.get('password')
    
    if username in users_db:
        return jsonify({'success': False, 'message': 'Username already taken'}), 400
        
    users_db[username] = {
        'password': password,
        'email': email,
        'plan': 'pending', 
        'premium_days': 0,
        'is_admin': False
    }
    
    return jsonify({'success': True})

@app.route('/ask', methods=['POST'])
def ask():
    data = request.json
    question = data.get('question', '').lower()
    
    responses = [
        "I see all.",
        "Your fate is sealed.",
        "The darkness knows.",
        "Why do you ask?",
        "It is already done.",
        "You cannot hide."
    ]
    
    if 'death' in question:
        return jsonify({'answer': "Soon."})
    elif 'love' in question:
        return jsonify({'answer': "A weakness."})
    else:
        import random
        return jsonify({'answer': random.choice(responses)})

@app.route('/upgrade_request', methods=['POST'])
def upgrade_request():
    username = session.get('user')
    if username:
        if username not in users_db:
            users_db[username] = {'password': 'temp', 'plan': 'free', 'premium_days': 0, 'is_admin': False}
        
        users_db[username]['plan'] = 'pending'
        return jsonify({'success': True})
    return jsonify({'success': False}), 401

@app.route('/admin/users', methods=['GET'])
def get_users():
    if session.get('user') != ADMIN_USER:
        return jsonify({'error': 'Unauthorized'}), 403
    
    user_list = []
    for u, details in users_db.items():
        if u != ADMIN_USER:
            user_list.append({
                'username': u,
                'plan': details['plan']
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

@app.route('/broadcast', methods=['POST'])
def broadcast():
    return jsonify({'success': True})

if __name__ == '__main__':
    app.run(debug=True)
