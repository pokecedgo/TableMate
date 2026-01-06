# Load YOLO11n-cls, train it on mnist160 for 3 epochs and predict an image with it
from ultralytics import YOLO

model = YOLO('yolo11n-cls.pt')  # load a pretrained YOLO11n classification model
model.train(data='datasets/animals', epochs=100)  # train the model
model('inference/images/bird.jpeg')  # predict on an image
